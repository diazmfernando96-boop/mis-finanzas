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

// Compatibilidad móvil
db.settings({
  experimentalAutoDetectLongPolling: true,
  merge: true
});

let currentUser = null;
let userDocRef = null;
let unsubscribeFirestore = null;

const STORAGE_KEYS = { 
  cards: "finanzas.tarjetas", 
  purchases: "finanzas.compras", 
  updatedAt: "finanzas.ultimaActualizacion",
  salary: "finanzas.sueldoConfig"
};

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
  constructor({ id = crypto.randomUUID(), nombre, montoTotal, saldoRestante = montoTotal, tarjeta, mesesSinIntereses = 1, mensualidadesPagadas = 0, fechaPrimerPago = null, fechaCompra = new Date().toISOString() }) {
    if (!tarjeta || !Number.isFinite(montoTotal) || !Number.isInteger(mesesSinIntereses) || mesesSinIntereses < 1) throw new Error("Datos de compra inválidos.");
    Object.assign(this, { id, nombre, montoTotal, saldoRestante, tarjeta, mesesSinIntereses, mensualidadesPagadas: Math.max(0, Math.min(mesesSinIntereses, Number(mensualidadesPagadas) || 0)), fechaPrimerPago, fechaCompra });
  }
}

function normalizePaymentDays(days) { 
  return [...new Set((Array.isArray(days) ? days : String(days).split(",")).map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))].sort((a, b) => a - b); 
}

const readStorage = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(key)); return value !== null ? value : fallback; } catch { return fallback; } };
const writeStorage = (key, value) => localStorage.setItem(key, JSON.stringify(value));

// Catálogo base de fuentes de financiamiento
const INITIAL_CARDS = [
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

// Compras históricas personales
const HISTORICAL_PURCHASES = [
  { compra: "LIVERPOOL PANTALLA", monto: 387 },
  { compra: "COLCHON SEARS", monto: 354 },
  { compra: "PROMODA", monto: 417 },
  { compra: "PRESTAMO MP", monto: 429.5 },
  { compra: "DIDI PRESTAMOS", monto: 964.95 },
  { compra: "PRESTAMO NU", monto: 4134 },
  { compra: "MOCHILA", monto: 1393 },
  { compra: "PC", monto: 5377 },
  { compra: "CELULAR", monto: 17388 },
  { compra: "SMARTWATCH", monto: 3601 },
  { compra: "SEGURO", monto: 4885 },
  { compra: "BICICLETA", monto: 5205 },
  { compra: "MITSUBISHI", monto: 141250 }
];

let cards = [];
let purchases = [];
let salaryConfig = { baseSalary: 0, currentIncome: 0, lastUpdated: "" };

// Función para guardar en el espacio del usuario actual en Firestore
async function saveToCloud() {
  if (!userDocRef) return;
  const timestamp = new Date().toISOString();
  localStorage.setItem(STORAGE_KEYS.cards, JSON.stringify(cards));
  localStorage.setItem(STORAGE_KEYS.purchases, JSON.stringify(purchases));
  localStorage.setItem(STORAGE_KEYS.salary, JSON.stringify(salaryConfig));
  localStorage.setItem(STORAGE_KEYS.updatedAt, timestamp);

  try {
    await userDocRef.set({
      cards: cards.map(c => ({ ...c })),
      purchases: purchases.map(p => ({ ...p })),
      salaryConfig: salaryConfig,
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

// Regla del 1 y 15: Del 1 al 14 -> Paga el 1; Del 15 al 31 -> Paga el 15
function calculateDefaultPaymentDay(dayNumber) {
  return (dayNumber >= 1 && dayNumber <= 14) ? 1 : 15;
}

// Fecha predeterminada de primer pago al registrar compra
function getDefaultFirstPaymentDate(baseDate = new Date()) {
  const day = baseDate.getDate();
  const paymentDay = calculateDefaultPaymentDay(day);
  let year = baseDate.getFullYear();
  let month = baseDate.getMonth();
  month += 1; // Siguiente ciclo
  return localDateValue(createDate(year, month, paymentDay));
}

// Agrupación de flujo de caja según la regla del 1 y 15
const cashFlowDate = (date) => {
  const day = date.getDate();
  return (day >= 1 && day <= 14) 
    ? createDate(date.getFullYear(), date.getMonth(), 1) 
    : createDate(date.getFullYear(), date.getMonth(), 15);
};

const sourceFor = (purchase) => cards.find(({ nombre }) => nombre === purchase.tarjeta);

function nextPaymentDate(days, from) {
  const normalized = normalizePaymentDays(days); const base = new Date(from); base.setHours(0, 0, 0, 0);
  for (let offset = 0; offset < 15; offset += 1) for (const day of normalized) { const candidate = createDate(base.getFullYear(), base.getMonth() + offset, day); if (candidate >= base) return candidate; }
  return new Date(base);
}

function paymentDates(source, count, baseDate) {
  if (!count) return [];
  if (source.tipo === "prestamo") { 
    const days = source.diasPago.length ? source.diasPago : [15, 30]; 
    const dates = []; 
    let cursor = baseDate; 
    for (let index = 0; index < count; index += 1) { 
      const date = nextPaymentDate(days, cursor); 
      dates.push(date); 
      cursor = new Date(date); 
      cursor.setDate(cursor.getDate() + 1); 
    } 
    return dates; 
  }
  
  const day = calculateDefaultPaymentDay(baseDate.getDate());
  const first = createDate(baseDate.getFullYear(), baseDate.getMonth() + 1, day);
  return Array.from({ length: count }, (_, index) => createDate(first.getFullYear(), first.getMonth() + index, day));
}

function projectPayments(purchase) {
  const source = sourceFor(purchase); if (!source) return [];
  const totalCents = Math.round(purchase.montoTotal * 100), baseCents = Math.floor(totalCents / purchase.mesesSinIntereses), paid = purchase.mensualidadesPagadas;
  const remainingNumbers = Array.from({ length: Math.max(0, purchase.mesesSinIntereses - paid) }, (_, index) => paid + index + 1);
  
  let dates = [];
  if (purchase.fechaPrimerPago) {
    const first = parseLocalDate(purchase.fechaPrimerPago);
    dates = remainingNumbers.map((_, index) => createDate(first.getFullYear(), first.getMonth() + paid + index, first.getDate()));
  } else {
    const purchaseDate = purchase.fechaCompra ? new Date(purchase.fechaCompra) : startOfToday();
    dates = paymentDates(source, remainingNumbers.length, purchaseDate);
  }
  
  return remainingNumbers.map((number, index) => ({ 
    number, 
    amount: (baseCents + (number === purchase.mesesSinIntereses ? totalCents - baseCents * purchase.mesesSinIntereses : 0)) / 100, 
    date: dates[index] || startOfToday(), 
    card: source.nombre 
  }));
}

const remainingBalance = (purchase) => projectPayments(purchase).reduce((sum, payment) => sum + payment.amount, 0);
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
const formatDate = (date) => dateFormatter.format(date).toUpperCase();
const allPayments = () => purchases.flatMap((purchase) => projectPayments(purchase).map((payment) => ({ ...payment, purchase, cashDate: cashFlowDate(payment.date) })));

function renderUpdatedBadge() { const raw = localStorage.getItem(STORAGE_KEYS.updatedAt); document.querySelector("#last-updated").textContent = raw ? `Actualizado: ${updatedFormatter.format(new Date(raw))}` : "Actualizado: —"; }

// Determinar si un pago cae en la quincena actual
function isPaymentInCurrentFortnight(paymentDate, today) {
  if (paymentDate.getFullYear() !== today.getFullYear() || paymentDate.getMonth() !== today.getMonth()) return false;
  const currentDay = today.getDate();
  const payDay = paymentDate.getDate();
  if (currentDay <= 15) {
    return payDay <= 15;
  } else {
    return payDay > 15;
  }
}

// Alerta y notificación inteligente de quincena
function checkFortnightNotification(today) {
  const day = today.getDate();
  const banner = document.querySelector("#fortnight-banner");
  const bannerTitle = document.querySelector("#banner-title");
  const bannerSubtitle = document.querySelector("#banner-subtitle");
  
  // Días de cobro: 14, 15, 16 o fin de mes (28, 29, 30, 31, 1)
  const isPayday = (day >= 14 && day <= 16) || day >= 28 || day === 1;

  if (isPayday) {
    banner.style.display = "flex";
    const periodo = day <= 16 ? "Quincena del 15" : "Quincena de fin de mes / día 1";
    bannerTitle.textContent = `🔔 ¡Cobro de ${periodo}!`;
    bannerSubtitle.textContent = `Registra el ingreso recibido para calcular cuánto dinero libre te queda tras cubrir los pagos de esta quincena.`;
    
    // Si tiene permiso de notificación del navegador y es exactamente día 15 o 30/31/1
    if ((day === 15 || day === 30 || day === 31 || day === 1) && window.Notification && Notification.permission === "granted") {
      new Notification("Finanzas Personales - Recordatorio de Quincena", {
        body: `Hoy es día de cobro (${periodo}). Revisa tus pagos programados y registra tu ingreso.`,
        icon: "https://cdn-icons-png.flaticon.com/512/2830/2830284.png"
      });
    }
  } else {
    banner.style.display = "none";
  }
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
  const today = startOfToday(), payments = allPayments(), total = purchases.reduce((sum, purchase) => sum + remainingBalance(purchase), 0), next = [...payments].sort((a, b) => a.date - b.date)[0];
  
  // Cálculo específico de pagos correspondientes a esta quincena
  const currentFortnightPayments = payments.filter(p => isPaymentInCurrentFortnight(p.date, today));
  const fortnightDebtTotal = currentFortnightPayments.reduce((sum, p) => sum + p.amount, 0);
  
  // Ingreso efectivo de la quincena (ingreso real o sueldo base)
  const effectiveIncome = Number(salaryConfig.currentIncome) || Number(salaryConfig.baseSalary) || 0;
  const availableCash = effectiveIncome - fortnightDebtTotal;

  // Actualizar indicadores de sueldo y dinero libre
  document.querySelector("#current-income-display").textContent = money.format(effectiveIncome);
  document.querySelector("#income-status-detail").textContent = salaryConfig.baseSalary ? `Base: ${money.format(salaryConfig.baseSalary)} / quincena` : 'Toca "💼 Sueldo" para configurar';

  const availableCashEl = document.querySelector("#available-cash-display");
  availableCashEl.textContent = money.format(availableCash);
  availableCashEl.style.color = availableCash >= 0 ? "#10b981" : "#fca5a5";
  document.querySelector("#available-cash-detail").textContent = availableCash >= 0 
    ? `Libre tras cubrir ${money.format(fortnightDebtTotal)} en pagos` 
    : `Déficit de ${money.format(Math.abs(availableCash))} esta quincena`;

  document.querySelector("#fortnight-debt-display").textContent = money.format(fortnightDebtTotal);
  document.querySelector("#fortnight-debt-detail").textContent = `${currentFortnightPayments.length} pago${currentFortnightPayments.length === 1 ? "" : "s"} este ciclo`;

  document.querySelector("#next-payment-date").textContent = next ? formatDate(next.date) : "—"; 
  document.querySelector("#next-payment-card").textContent = next ? next.card : "Sin pagos próximos";
  
  document.querySelector("#cards-table-body").innerHTML = cards.map((source) => { const tipoLabel = source.tipo === "prestamo" ? "Préstamo" : (source.tipo === "departamental" ? "Departamental" : "Tarjeta"); return `<tr><td>${escapeHtml(source.nombre)}</td><td>${tipoLabel}</td><td>${sourceSchedule(source)}</td><td>${money.format(purchases.filter(({ tarjeta }) => tarjeta === source.nombre).reduce((sum, purchase) => sum + remainingBalance(purchase), 0))}</td></tr>`}).join("");
  document.querySelector("#purchases-table-body").innerHTML = purchases.length ? purchases.map((purchase) => { const installments = projectPayments(purchase), first = installments[0]; return `<tr><td>${escapeHtml(purchase.nombre)}</td><td>${escapeHtml(purchase.tarjeta)}</td><td>${first ? money.format(first.amount) : money.format(0)} / ${purchase.mesesSinIntereses} MSI</td><td>${first ? formatDate(first.date) : "Finalizado"}</td></tr>`; }).join("") : '<tr><td colspan="4" class="muted">Aún no hay compras registradas.</td></tr>';
  
  const cardOptions = cards.filter(({ tipo }) => tipo === "tarjeta").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  const loanOptions = cards.filter(({ tipo }) => tipo === "prestamo").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  const deptOptions = cards.filter(({ tipo }) => tipo === "departamental").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  document.querySelector("#purchase-card").innerHTML = `${cardOptions ? `<optgroup label="Tarjetas de Crédito
