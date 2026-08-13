// 1. Configuración de Firebase
const firebaseConfig = {
  apiKey: "AIzaSyDCJnGNyd838CEaEB6tu4Y01X3ZUD3sCH0",
  authDomain: "mis-finanzas-5f1f5.firebaseapp.com",
  projectId: "mis-finanzas-5f1f5",
  storageBucket: "mis-finanzas-5f1f5.appspot.com",
  messagingSenderId: "665281319781",
  appId: "1:665281319781:web:cb16f907766e3184f8078c"
};

// 2. Inicializar Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

let currentUser = null;
let userDocRef = null;
let unsubscribeFirestore = null;

const STORAGE_KEYS = { cards: "finanzas.tarjetas", purchases: "finanzas.compras", updatedAt: "finanzas.ultimaActualizacion" };
const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const dateFormatter = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short" });
const monthFormatter = new Intl.DateTimeFormat("es-MX", { month: "short" });
const updatedFormatter = new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
let debtChart = null, flowChart = null, editingPurchaseId = null, editingSourceName = null;

class FuenteFinanciamiento {
  constructor(nombre, diaCorte = 15, diaLimitePago = 15, tipo = "tarjeta", diasPago = []) {
    Object.assign(this, { nombre, diaCorte, diaLimitePago, tipo, diasPago: normalizePaymentDays(diasPago) });
  }
}
class Compra {
  constructor({ id = crypto.randomUUID(), nombre, montoTotal, saldoRestante = montoTotal, tarjeta, mesesSinIntereses, mensualidadesPagadas = 0, fechaPrimerPago = null, fechaCompra = new Date().toISOString() }) {
    if (!tarjeta || !Number.isFinite(montoTotal) || !Number.isInteger(mesesSinIntereses) || mesesSinIntereses < 1) throw new Error("Datos de compra inválidos.");
    Object.assign(this, { id, nombre, montoTotal, saldoRestante, tarjeta, mesesSinIntereses, mensualidadesPagadas: Math.max(0, Math.min(mesesSinIntereses, Number(mensualidadesPagadas) || 0)), fechaPrimerPago, fechaCompra });
  }
}

function normalizePaymentDays(days) { return [...new Set((Array.isArray(days) ? days : String(days).split(",")).map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))].sort((a, b) => a - b); }
const readStorage = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : fallback; } catch { return fallback; } };
const writeStorage = (key, value) => localStorage.setItem(key, JSON.stringify(value));

let cards = [];
let purchases = [];

// Plantilla de fuentes predeterminadas para nuevos usuarios
const DEFAULT_CARDS = [
  new FuenteFinanciamiento("BBVA ORO", 15, 5, "tarjeta"),
  new FuenteFinanciamiento("BBVA AZUL", 15, 5, "tarjeta"),
  new FuenteFinanciamiento("DIDI CARD", 15, 5, "tarjeta"),
  new FuenteFinanciamiento("MP TDC", 15, 5, "tarjeta"),
  new FuenteFinanciamiento("NU TDC", 15, 5, "tarjeta"),
  new FuenteFinanciamiento('PROMODA "BRADESCARD"', 15, 5, "tarjeta"),
  new FuenteFinanciamiento("PLATA CARD", 15, 5, "tarjeta"),
  new FuenteFinanciamiento("MP Prestamos", 15, 15, "prestamo", [15, 30]),
  new FuenteFinanciamiento("DIDI Prestamos", 15, 15, "prestamo", [15, 30]),
  new FuenteFinanciamiento("NU Prestamos", 15, 15, "prestamo", [15, 30]),
  new FuenteFinanciamiento("Liverpool Prestamos", 15, 15, "prestamo", [15, 30]),
  new FuenteFinanciamiento("LIVERPOOL", 15, 5, "departamental"),
  new FuenteFinanciamiento("PALACIO DE HIERRO", 15, 5, "departamental"),
  new FuenteFinanciamiento("SANBORNS", 15, 5, "departamental"),
  new FuenteFinanciamiento("SEARS", 15, 5, "departamental")
];

// Función para guardar en el espacio del usuario actual en Firestore
async function saveToCloud() {
  if (!userDocRef) return;
  const timestamp = new Date().toISOString();
  localStorage.setItem(STORAGE_KEYS.cards, JSON.stringify(cards));
  localStorage.setItem(STORAGE_KEYS.purchases, JSON.stringify(purchases));
  localStorage.setItem(STORAGE_KEYS.updatedAt, timestamp);

  try {
    await userDocRef.set({
      cards: cards.map(c => ({ ...c })),
      purchases: purchases.map(p => ({ ...p })),
      updatedAt: timestamp
    });
  } catch (err) {
    console.error("Error al guardar en Firestore:", err);
  }
}

const createDate = (year, month, day) => new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate()));
const localDateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseLocalDate = (value) => { const [year, month, day] = String(value).split("-").map(Number); return createDate(year, month - 1, day); };
const startOfToday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date; };
const standardPaymentDay = (day) => Math.abs(day - 1) < Math.abs(day - 15) ? 1 : 15;
const cashFlowDate = (date) => date.getDate() <= 15 ? createDate(date.getFullYear(), date.getMonth(), 15) : createDate(date.getFullYear(), date.getMonth() + 1, 0);
const sourceFor = (purchase) => cards.find(({ nombre }) => nombre === purchase.tarjeta);

function nextPaymentDate(days, from) {
  const normalized = normalizePaymentDays(days); const base = new Date(from); base.setHours(0, 0, 0, 0);
  for (let offset = 0; offset < 15; offset += 1) for (const day of normalized) { const candidate = createDate(base.getFullYear(), base.getMonth() + offset, day); if (candidate >= base) return candidate; }
  return new Date(base);
}
function paymentDates(source, count, today) {
  if (!count) return [];
  if (source.tipo === "prestamo") { const days = source.diasPago.length ? source.diasPago : [15, 30]; const dates = []; let cursor = today; for (let index = 0; index < count; index += 1) { const date = nextPaymentDate(days, cursor); dates.push(date); cursor = new Date(date); cursor.setDate(cursor.getDate() + 1); } return dates; }
  const day = standardPaymentDay(source.diaCorte); const first = createDate(today.getFullYear(), today.getMonth(), day); if (first < today) first.setMonth(first.getMonth() + 1); return Array.from({ length: count }, (_, index) => createDate(first.getFullYear(), first.getMonth() + index, day));
}
function projectPayments(purchase) {
  const source = sourceFor(purchase); if (!source) return [];
  const totalCents = Math.round(purchase.montoTotal * 100), baseCents = Math.floor(totalCents / purchase.mesesSinIntereses), paid = purchase.mensualidadesPagadas;
  const remainingNumbers = Array.from({ length: Math.max(0, purchase.mesesSinIntereses - paid) }, (_, index) => paid + index + 1);
  const dates = purchase.fechaPrimerPago ? remainingNumbers.map((_, index) => { const first = parseLocalDate(purchase.fechaPrimerPago); return createDate(first.getFullYear(), first.getMonth() + paid + index, first.getDate()); }) : paymentDates(source, remainingNumbers.length, startOfToday());
  return remainingNumbers.map((number, index) => ({ number, amount: (baseCents + (number === purchase.mesesSinIntereses ? totalCents - baseCents * purchase.mesesSinIntereses : 0)) / 100, date: dates[index], card: source.nombre }));
}
const remainingBalance = (purchase) => projectPayments(purchase).reduce((sum, payment) => sum + payment.amount, 0);
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
const formatDate = (date) => dateFormatter.format(date).toUpperCase();
const allPayments = () => purchases.flatMap((purchase) => projectPayments(purchase).map((payment) => ({ ...payment, purchase, cashDate: cashFlowDate(payment.date) })));

function renderUpdatedBadge() { const raw = localStorage.getItem(STORAGE_KEYS.updatedAt); document.querySelector("#last-updated").textContent = raw ? `Actualizado: ${updatedFormatter.format(new Date(raw))}` : "Actualizado: —"; }

function renderPokemonEasterEgg() { 
  const layer = document.querySelector("#pokemon-layer"); 
  if (!layer) return;
  layer.style.opacity = '0';
  setTimeout(() => {
    const count = Math.floor(Math.random() * 5) + 10; 
    const usedIds = new Set(); 
    while (usedIds.size < count) usedIds.add(Math.floor(Math.random() * 151) + 1); 
    const edgeSlots = [
      { edge: 'top', pos: 15 }, { edge: 'top', pos: 35 }, { edge: 'top', pos: 65 }, { edge: 'top', pos: 85 },
      { edge: 'bottom', pos: 15 }, { edge: 'bottom', pos: 35 }, { edge: 'bottom', pos: 65 }, { edge: 'bottom', pos: 85 },
      { edge: 'left', pos: 5 }, { edge: 'left', pos: 15 }, { edge: 'left', pos: 25 }, { edge: 'left', pos: 35 }, { edge: 'left', pos: 45 }, { edge: 'left', pos: 55 }, { edge: 'left', pos: 65 }, { edge: 'left', pos: 75 }, { edge: 'left', pos: 85 }, { edge: 'left', pos: 95 },
      { edge: 'right', pos: 5 }, { edge: 'right', pos: 15 }, { edge: 'right', pos: 25 }, { edge: 'right', pos: 35 }, { edge: 'right', pos: 45 }, { edge: 'right', pos: 55 }, { edge: 'right', pos: 65 }, { edge: 'right', pos: 75 }, { edge: 'right', pos: 85 }, { edge: 'right', pos: 95 }
    ];
    const shuffledSlots = edgeSlots.sort(() => 0.5 - Math.random()).slice(0, count);
    layer.innerHTML = [...usedIds].map((id, index) => {
      const slot = shuffledSlots[index];
      const delay = (Math.random() * 4).toFixed(2); 
      const variation = (Math.random() * 4 - 2).toFixed(2);
      const finalPos = slot.pos + Number(variation);
      let style = "", animClass = "";
      if (slot.edge === 'top') { style = `top: -50px; left: ${finalPos}%;`; animClass = "pokemon-peek-top"; }
      else if (slot.edge === 'bottom') { style = `bottom: -50px; left: ${finalPos}%;`; animClass = "pokemon-peek-bottom"; }
      else if (slot.edge === 'left') { style = `top: ${finalPos}%; left: -50px;`; animClass = "pokemon-peek-left"; }
      else { style = `top: ${finalPos}%; right: -50px;`; animClass = "pokemon-peek-right"; }
      return `<img class="pokemon ${animClass}" src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${id}.gif" style="${style} animation-delay: ${delay}s;" alt="" />`;
    }).join(""); 
    layer.style.opacity = '1';
  }, 600); 
}

function renderCharts(payments, total, today) {
  document.querySelector("#chart-debt-total").textContent = money.format(total); if (!window.Chart) return;
  const breakdown = cards.map((card) => ({ label: card.nombre, value: purchases.filter(({ tarjeta }) => tarjeta === card.nombre).reduce((sum, purchase) => sum + remainingBalance(purchase), 0) })).filter(({ value }) => value > 0);
  if (debtChart) debtChart.destroy(); debtChart = new Chart(document.querySelector("#debt-chart"), { type: "doughnut", data: { labels: breakdown.length ? breakdown.map(({ label }) => label) : ["Sin deuda"], datasets: [{ data: breakdown.length ? breakdown.map(({ value }) => value) : [1], backgroundColor: breakdown.length ? ["#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#ec4899"] : ["rgba(255,255,255,.10)"], borderWidth: 0, hoverOffset: 5 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "76%", plugins: { legend: { display: false } } } });
  const months = Array.from({ length: 3 }, (_, index) => new Date(today.getFullYear(), today.getMonth() + index, 1)); const amounts = months.map((month) => payments.filter(({ date }) => date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth()).reduce((sum, payment) => sum + payment.amount, 0)); const canvas = document.querySelector("#flow-chart"), gradient = canvas.getContext("2d").createLinearGradient(0, 0, 0, 220); gradient.addColorStop(0, "rgba(139,92,246,.48)"); gradient.addColorStop(1, "rgba(59,130,246,0)");
  if (flowChart) flowChart.destroy(); flowChart = new Chart(canvas, { type: "line", data: { labels: months.map((month) => monthFormatter.format(month).toUpperCase()), datasets: [{ data: amounts, borderColor: "#a78bfa", borderWidth: 3, backgroundColor: gradient, fill: true, tension: .4, pointBackgroundColor: "#10b981", pointBorderColor: "#09090e", pointBorderWidth: 3, pointRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: "#858ba2" } }, y: { display: false, beginAtZero: true } }, plugins: { legend: { display: false } } } });
}

function renderBreakdown(payments) { const body = document.querySelector("#breakdown-table-body"); const future = payments.sort((a, b) => a.date - b.date); body.innerHTML = future.length ? future.map((payment) => `<tr><td>${formatDate(payment.date)}</td><td>${escapeHtml(payment.purchase.nombre)}</td><td>${escapeHtml(payment.card)}</td><td>${payment.number}/${payment.purchase.mesesSinIntereses}</td><td>${money.format(payment.amount)}</td></tr>`).join("") : '<tr><td colspan="5" class="muted">No hay pagos futuros por proyectar.</td></tr>'; }
function sourceSchedule(source) { return source.tipo === "prestamo" ? `Días ${source.diasPago.join(", ") || "15, 30"}` : `Corte ${source.diaCorte} · Pago ${source.diaLimitePago}`; }
function renderManagePurchases() { const body = document.querySelector("#manage-table-body"); body.innerHTML = purchases.length ? purchases.map((purchase) => `<tr><td>${escapeHtml(purchase.nombre)}</td><td>${money.format(purchase.montoTotal)}</td><td>${escapeHtml(purchase.tarjeta)}</td><td>${purchase.mensualidadesPagadas}/${purchase.mesesSinIntereses}</td><td class="action-cell"><button class="action-button" data-action="edit" data-id="${purchase.id}" type="button">Editar</button><button class="action-button danger-button" data-action="delete" data-id="${purchase.id}" type="button">Eliminar</button></td></tr>`).join("") : '<tr><td colspan="5" class="muted">Aún no hay compras registradas.</td></tr>'; }
function renderManageCards() { const body = document.querySelector("#manage-cards-table-body"); body.innerHTML = cards.map((source) => { const inUse = purchases.some(({ tarjeta }) => tarjeta === source.nombre), cannotDelete = cards.length === 1 && inUse; const tipoLabel = source.tipo === "prestamo" ? "Préstamo personal" : (source.tipo === "departamental" ? "Departamental" : "Tarjeta de crédito"); return `<tr><td>${escapeHtml(source.nombre)}</td><td>${tipoLabel}</td><td>${sourceSchedule(source)}</td><td class="action-cell"><button class="action-button" data-source-action="edit" data-source-name="${escapeHtml(source.nombre)}" type="button">Editar</button><button class="action-button danger-button" data-source-action="delete" data-source-name="${escapeHtml(source.nombre)}" type="button" ${cannotDelete ? "disabled" : ""}>Eliminar</button></td></tr>`; }).join(""); }
function renderTotalsAndAlert(payments, total) { document.querySelector("#global-debt").textContent = money.format(total); document.querySelector("#global-debt-detail").textContent = `${purchases.length} compra${purchases.length === 1 ? "" : "s"} activa${purchases.length === 1 ? "" : "s"}`; const next = [...payments].sort((a, b) => a.date - b.date)[0]; document.querySelector("#urgent-date").textContent = next ? `Pago: ${formatDate(next.date)}` : "Sin pagos próximos"; document.querySelector("#urgent-card").textContent = next ? next.card : "—"; document.querySelector("#urgent-amount").textContent = money.format(next?.amount || 0); }

function render() {
  const today = startOfToday(), payments = allPayments(), total = purchases.reduce((sum, purchase) => sum + remainingBalance(purchase), 0), next = [...payments].sort((a, b) => a.date - b.date)[0], monthPayments = payments.filter(({ date }) => date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth());
  document.querySelector("#total-balance").textContent = money.format(total);
  document.querySelector("#balance-detail").textContent = purchases.length ? `${purchases.length} compra${purchases.length === 1 ? "" : "s"} activa${purchases.length === 1 ? "" : "s"}` : "Sin compras registradas";
  document.querySelector("#monthly-payments").textContent = money.format(monthPayments.reduce((sum, payment) => sum + payment.amount, 0));
  document.querySelector("#monthly-payment-detail").textContent = `${monthPayments.length} pago${monthPayments.length === 1 ? "" : "s"} proyectado${monthPayments.length === 1 ? "" : "s"}`;
  document.querySelector("#msi-count").textContent = purchases.length; document.querySelector("#financed-total").textContent = `${money.format(total)} financiados`;
  document.querySelector("#next-payment-date").textContent = next ? formatDate(next.date) : "—"; document.querySelector("#next-payment-card").textContent = next ? next.card : "Sin pagos próximos";
  
  document.querySelector("#cards-table-body").innerHTML = cards.map((source) => { const tipoLabel = source.tipo === "prestamo" ? "Préstamo" : (source.tipo === "departamental" ? "Departamental" : "Tarjeta"); return `<tr><td>${escapeHtml(source.nombre)}</td><td>${tipoLabel}</td><td>${sourceSchedule(source)}</td><td>${money.format(purchases.filter(({ tarjeta }) => tarjeta === source.nombre).reduce((sum, purchase) => sum + remainingBalance(purchase), 0))}</td></tr>`}).join("");
  document.querySelector("#purchases-table-body").innerHTML = purchases.length ? purchases.map((purchase) => { const installments = projectPayments(purchase), first = installments[0]; return `<tr><td>${escapeHtml(purchase.nombre)}</td><td>${escapeHtml(purchase.tarjeta)}</td><td>${first ? money.format(first.amount) : money.format(0)} / ${purchase.mesesSinIntereses} MSI</td><td>${first ? formatDate(first.date) : "Finalizado"}</td></tr>`; }).join("") : '<tr><td colspan="4" class="muted">Aún no hay compras registradas.</td></tr>';
  
  const cardOptions = cards.filter(({ tipo }) => tipo === "tarjeta").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  const loanOptions = cards.filter(({ tipo }) => tipo === "prestamo").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  const deptOptions = cards.filter(({ tipo }) => tipo === "departamental").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  document.querySelector("#purchase-card").innerHTML = `${cardOptions ? `<optgroup label="Tarjetas de Crédito">${cardOptions}</optgroup>` : ""}${loanOptions ? `<optgroup label="Préstamos Personales">${loanOptions}</optgroup>` : ""}${deptOptions ? `<optgroup label="Departamentales">${deptOptions}</optgroup>` : ""}`;
  
  renderBreakdown(payments); renderManagePurchases(); renderManageCards(); renderTotalsAndAlert(payments, total); renderUpdatedBadge(); renderCharts(payments, total, today);
}

const purchaseModal = document.querySelector("#purchase-modal"), purchaseForm = document.querySelector("#purchase-form"), sourceModal = document.querySelector("#card-modal"), sourceForm = document.querySelector("#card-form");
function closePurchaseModal() { purchaseModal.classList.remove("is-open"); purchaseModal.setAttribute("aria-hidden", "true"); editingPurchaseId = null; }
function openPurchaseModal(purchase = null) { 
  editingPurchaseId = purchase?.id ?? null; purchaseForm.reset(); 
  document.querySelector("#modal-title").textContent = purchase ? "Editar compra" : "Registrar compra"; 
  document.querySelector("#save-purchase").textContent = purchase ? "Guardar cambios" : "Guardar compra"; 
  if (purchase) { 
    document.querySelector("#purchase-name").value = purchase.nombre; 
    document.querySelector("#purchase-amount").value = purchase.montoTotal; 
    document.querySelector("#purchase-card").value = purchase.tarjeta; 
    document.querySelector("#purchase-months").value = purchase.mesesSinIntereses; 
    document.querySelector("#purchase-paid-months").value = purchase.mensualidadesPagadas; 
    if (purchase.fechaPrimerPago) document.querySelector("#fechaPrimerPago").value = purchase.fechaPrimerPago;
  } 
  purchaseModal.classList.add("is-open"); purchaseModal.setAttribute("aria-hidden", "false"); document.querySelector("#purchase-name").focus(); 
}
function closeSourceModal() { sourceModal. 
