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
  constructor({ 
    id = crypto.randomUUID(), 
    nombre, 
    montoTotal, 
    saldoRestante = montoTotal, 
    tarjeta, 
    frecuenciaPago = "mensual",
    mesesSinIntereses = 1, 
    mensualidadesPagadas = 0, 
    fechaPrimerPago = null, 
    fechaCompra = new Date().toISOString() 
  }) {
    if (!tarjeta || !Number.isFinite(montoTotal) || !Number.isInteger(Number(mesesSinIntereses)) || Number(mesesSinIntereses) < 1) {
      throw new Error("Datos de compra inválidos.");
    }
    const plazos = Number(mesesSinIntereses);
    const pagados = Math.max(0, Math.min(plazos, Number(mensualidadesPagadas) || 0));
    Object.assign(this, { 
      id, 
      nombre, 
      montoTotal, 
      saldoRestante, 
      tarjeta, 
      frecuenciaPago: frecuenciaPago === "quincenal" ? "quincenal" : "mensual",
      mesesSinIntereses: plazos, 
      mensualidadesPagadas: pagados, 
      fechaPrimerPago, 
      fechaCompra 
    });
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

// Guardar en Firestore
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

function calculateDefaultPaymentDay(dayNumber) {
  return (dayNumber >= 1 && dayNumber <= 14) ? 1 : 15;
}

function getDefaultFirstPaymentDate(baseDate = new Date()) {
  const day = baseDate.getDate();
  const paymentDay = calculateDefaultPaymentDay(day);
  let year = baseDate.getFullYear();
  let month = baseDate.getMonth();
  month += 1;
  return localDateValue(createDate(year, month, paymentDay));
}

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

// Proyección de Pagos adaptada a Frecuencia Quincenal o Mensual
function projectPayments(purchase) {
  const source = sourceFor(purchase); 
  if (!source) return [];
  const totalCents = Math.round(purchase.montoTotal * 100);
  const plazos = purchase.mesesSinIntereses || 1;
  const baseCents = Math.floor(totalCents / plazos);
  const paid = purchase.mensualidadesPagadas || 0;
  const remainingCount = Math.max(0, plazos - paid);
  const remainingNumbers = Array.from({ length: remainingCount }, (_, index) => paid + index + 1);
  
  if (remainingCount === 0) return [];

  let firstDate;
  if (purchase.fechaPrimerPago) {
    firstDate = parseLocalDate(purchase.fechaPrimerPago);
  } else {
    const purchaseDate = purchase.fechaCompra ? new Date(purchase.fechaCompra) : startOfToday();
    const payDay = calculateDefaultPaymentDay(purchaseDate.getDate());
    firstDate = createDate(purchaseDate.getFullYear(), purchaseDate.getMonth() + 1, payDay);
  }

  // Generar la secuencia completa de fechas
  let allDates = [];
  if (purchase.frecuenciaPago === "quincenal") {
    let current = new Date(firstDate);
    for (let i = 0; i < plazos; i++) {
      allDates.push(new Date(current));
      const day = current.getDate();
      const year = current.getFullYear();
      const month = current.getMonth();
      if (day <= 14) {
        current = createDate(year, month, 15);
      } else {
        current = createDate(year, month + 1, 1);
      }
    }
  } else {
    // Mensual
    for (let i = 0; i < plazos; i++) {
      allDates.push(createDate(firstDate.getFullYear(), firstDate.getMonth() + i, firstDate.getDate()));
    }
  }

  const remainingDates = allDates.slice(paid);

  return remainingNumbers.map((number, index) => ({ 
    number, 
    totalPlazos: plazos,
    frecuencia: purchase.frecuenciaPago || "mensual",
    amount: (baseCents + (number === plazos ? totalCents - baseCents * plazos : 0)) / 100, 
    date: remainingDates[index] || startOfToday(), 
    card: source.nombre 
  }));
}

const remainingBalance = (purchase) => projectPayments(purchase).reduce((sum, payment) => sum + payment.amount, 0);
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
const formatDate = (date) => dateFormatter.format(date).toUpperCase();
const allPayments = () => purchases.flatMap((purchase) => projectPayments(purchase).map((payment) => ({ ...payment, purchase, cashDate: cashFlowDate(payment.date) })));

function renderUpdatedBadge() { const raw = localStorage.getItem(STORAGE_KEYS.updatedAt); document.querySelector("#last-updated").textContent = raw ? `Actualizado: ${updatedFormatter.format(new Date(raw))}` : "Actualizado: —"; }

// Determinar pagos que vencen en la quincena del 15 del mes actual
function isPaymentInFortnight15(paymentDate, today) {
  return paymentDate.getFullYear() === today.getFullYear() && 
         paymentDate.getMonth() === today.getMonth() && 
         paymentDate.getDate() <= 15;
}

// Determinar qué pagos corresponden al ciclo quincenal activo
function isPaymentInCurrentFortnight(paymentDate, today) {
  const currentDay = today.getDate();
  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();
  
  const payDay = paymentDate.getDate();
  const payMonth = paymentDate.getMonth();
  const payYear = paymentDate.getFullYear();
  
  if (currentDay <= 15) {
    return payYear === currentYear && payMonth === currentMonth && payDay <= 15;
  } else {
    const isSameMonthEnd = (payYear === currentYear && payMonth === currentMonth && payDay > 15);
    const nextMonthDate = new Date(currentYear, currentMonth + 1, 1);
    const isNextMonthStart = (payYear === nextMonthDate.getFullYear() && payMonth === nextMonthDate.getMonth() && payDay <= 14);
    return isSameMonthEnd || isNextMonthStart;
  }
}

// Animación de Pokémon
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
      return `<img class="pokemon ${animClass}" loading="lazy" src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${id}.gif" style="${style} animation-delay: ${delay}s;" alt="" />`;
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

function renderBreakdown(payments) { 
  const body = document.querySelector("#breakdown-table-body"); 
  const future = payments.sort((a, b) => a.date - b.date); 
  body.innerHTML = future.length ? future.map((payment) => {
    const isQ = payment.frecuencia === "quincenal";
    const label = isQ ? "QNA" : "MSI";
    return `<tr>
      <td>${formatDate(payment.date)}</td>
      <td>${escapeHtml(payment.purchase.nombre)}</td>
      <td>${escapeHtml(payment.card)}</td>
      <td>${payment.number}/${payment.totalPlazos} ${label}</td>
      <td>${money.format(payment.amount)}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="5" class="muted">No hay pagos futuros por proyectar.</td></tr>'; 
}

function sourceSchedule(source) { return source.tipo === "prestamo" ? `Días ${source.diasPago.join(", ") || "15, 30"}` : `Corte ${source.diaCorte} · Pago ${source.diaLimitePago}`; }

function renderManagePurchases() { 
  const body = document.querySelector("#manage-table-body"); 
  body.innerHTML = purchases.length ? purchases.map((purchase) => {
    const isQ = purchase.frecuenciaPago === "quincenal";
    const label = isQ ? "QNA" : "MSI";
    return `<tr>
      <td>${escapeHtml(purchase.nombre)}</td>
      <td>${money.format(purchase.montoTotal)}</td>
      <td>${escapeHtml(purchase.tarjeta)}</td>
      <td>${purchase.mensualidadesPagadas}/${purchase.mesesSinIntereses} ${label}</td>
      <td class="action-cell">
        <button class="action-button" data-action="edit" data-id="${purchase.id}" type="button">Editar</button>
        <button class="action-button danger-button" data-action="delete" data-id="${purchase.id}" type="button">Eliminar</button>
      </td>
    </tr>`;
  }).join("") : '<tr><td colspan="5" class="muted">Aún no hay compras registradas.</td></tr>'; 
}

function renderManageCards() { const body = document.querySelector("#manage-cards-table-body"); body.innerHTML = cards.map((source) => { const inUse = purchases.some(({ tarjeta }) => tarjeta === source.nombre), cannotDelete = cards.length === 1 && inUse; const tipoLabel = source.tipo === "prestamo" ? "Préstamo personal" : (source.tipo === "departamental" ? "Departamental" : "Tarjeta de crédito"); return `<tr><td>${escapeHtml(source.nombre)}</td><td>${tipoLabel}</td><td>${sourceSchedule(source)}</td><td class="action-cell"><button class="action-button" data-source-action="edit" data-source-name="${escapeHtml(source.nombre)}" type="button">Editar</button><button class="action-button danger-button" data-source-action="delete" data-source-name="${escapeHtml(source.nombre)}" type="button" ${cannotDelete ? "disabled" : ""}>Eliminar</button></td></tr>`; }).join(""); }
function renderTotalsAndAlert(payments, total) { document.querySelector("#global-debt").textContent = money.format(total); document.querySelector("#global-debt-detail").textContent = `${purchases.length} compra${purchases.length === 1 ? "" : "s"} activa${purchases.length === 1 ? "" : "s"}`; const next = [...payments].sort((a, b) => a.date - b.date)[0]; document.querySelector("#urgent-date").textContent = next ? `Pago: ${formatDate(next.date)}` : "Sin pagos próximos"; document.querySelector("#urgent-card").textContent = next ? next.card : "—"; document.querySelector("#urgent-amount").textContent = money.format(next?.amount || 0); }

function render() {
  const today = startOfToday(), payments = allPayments(), total = purchases.reduce((sum, purchase) => sum + remainingBalance(purchase), 0), next = [...payments].sort((a, b) => a.date - b.date)[0];
  
  // 1. Cobro exclusivo de la quincena del 15 para Dashboard
  const payments15 = payments.filter(p => isPaymentInFortnight15(p.date, today));
  const totalFortnight15 = payments15.reduce((sum, p) => sum + p.amount, 0);

  document.querySelector("#total-balance").textContent = money.format(total);
  document.querySelector("#balance-detail").textContent = purchases.length ? `${purchases.length} compra${purchases.length === 1 ? "" : "s"} activa${purchases.length === 1 ? "" : "s"}` : "Sin compras registradas";
  
  document.querySelector("#fortnight-15-display").textContent = money.format(totalFortnight15);
  document.querySelector("#fortnight-15-detail").textContent = `${payments15.length} pago${payments15.length === 1 ? "" : "s"} al día 15`;

  document.querySelector("#msi-count").textContent = purchases.length; 
  document.querySelector("#financed-total").textContent = `${money.format(total)} financiados`;

  document.querySelector("#next-payment-date").textContent = next ? formatDate(next.date) : "—"; 
  document.querySelector("#next-payment-card").textContent = next ? next.card : "Sin pagos próximos";
  
  // 2. Renderizado de la Pantalla de Sueldo
  const currentFortnightPayments = payments.filter(p => isPaymentInCurrentFortnight(p.date, today));
  const fortnightDebtTotal = currentFortnightPayments.reduce((sum, p) => sum + p.amount, 0);
  const effectiveIncome = Number(salaryConfig.currentIncome) || Number(salaryConfig.baseSalary) || 0;
  const availableCash = effectiveIncome - fortnightDebtTotal;

  document.querySelector("#salary-base-input").value = salaryConfig.baseSalary || "";
  document.querySelector("#salary-income-input").value = salaryConfig.currentIncome || salaryConfig.baseSalary || "";

  document.querySelector("#salary-income-display").textContent = money.format(effectiveIncome);
  document.querySelector("#salary-income-base-detail").textContent = salaryConfig.baseSalary ? `Base: ${money.format(salaryConfig.baseSalary)} / quincena` : "Sin sueldo base definido";

  document.querySelector("#salary-fortnight-debt-display").textContent = money.format(fortnightDebtTotal);
  document.querySelector("#salary-fortnight-debt-detail").textContent = `${currentFortnightPayments.length} pago${currentFortnightPayments.length === 1 ? "" : "s"} en este ciclo`;

  const availableCashEl = document.querySelector("#salary-available-cash-display");
  availableCashEl.textContent = money.format(availableCash);
  availableCashEl.style.color = availableCash >= 0 ? "#10b981" : "#fca5a5";
  document.querySelector("#salary-available-cash-detail").textContent = availableCash >= 0 
    ? `Libre tras cubrir ${money.format(fortnightDebtTotal)} en pagos` 
    : `Déficit de ${money.format(Math.abs(availableCash))} esta quincena`;

  const salaryTableBody = document.querySelector("#salary-payments-table-body");
  salaryTableBody.innerHTML = currentFortnightPayments.length ? currentFortnightPayments.map((p) => `<tr><td>${formatDate(p.date)}</td><td>${escapeHtml(p.purchase.nombre)}</td><td>${escapeHtml(p.card)}</td><td>${money.format(p.amount)}</td></tr>`).join("") : '<tr><td colspan="4" class="muted">No hay pagos programados para esta quincena.</td></tr>';

  // 3. Tablas de Fuentes y Compras en Dashboard
  document.querySelector("#cards-table-body").innerHTML = cards.map((source) => { const tipoLabel = source.tipo === "prestamo" ? "Préstamo" : (source.tipo === "departamental" ? "Departamental" : "Tarjeta"); return `<tr><td>${escapeHtml(source.nombre)}</td><td>${tipoLabel}</td><td>${sourceSchedule(source)}</td><td>${money.format(purchases.filter(({ tarjeta }) => tarjeta === source.nombre).reduce((sum, purchase) => sum + remainingBalance(purchase), 0))}</td></tr>`}).join("");
  
  document.querySelector("#purchases-table-body").innerHTML = purchases.length ? purchases.map((purchase) => { 
    const installments = projectPayments(purchase), first = installments[0]; 
    const isQ = purchase.frecuenciaPago === "quincenal";
    const label = isQ ? "QNA" : "MSI";
    return `<tr><td>${escapeHtml(purchase.nombre)}</td><td>${escapeHtml(purchase.tarjeta)}</td><td>${first ? money.format(first.amount) : money.format(0)} / ${purchase.mesesSinIntereses} ${label}</td><td>${first ? formatDate(first.date) : "Finalizado"}</td></tr>`; 
  }).join("") : '<tr><td colspan="4" class="muted">Aún no hay compras registradas.</td></tr>';
  
  const cardOptions = cards.filter(({ tipo }) => tipo === "tarjeta").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  const loanOptions = cards.filter(({ tipo }) => tipo === "prestamo").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  const deptOptions = cards.filter(({ tipo }) => tipo === "departamental").map(({ nombre }) => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join("");
  document.querySelector("#purchase-card").innerHTML = `${cardOptions ? `<optgroup label="Tarjetas de Crédito">${cardOptions}</optgroup>` : ""}${loanOptions ? `<optgroup label="Préstamos Personales">${loanOptions}</optgroup>` : ""}${deptOptions ? `<optgroup label="Departamentales">${deptOptions}</optgroup>` : ""}`;
  
  renderBreakdown(payments); 
  renderManagePurchases(); 
  renderManageCards(); 
  renderTotalsAndAlert(payments, total); 
  renderUpdatedBadge(); 
  renderCharts(payments, total, today);
}

// Modales y Formularios
const purchaseModal = document.querySelector("#purchase-modal"), purchaseForm = document.querySelector("#purchase-form");
const sourceModal = document.querySelector("#card-modal"), sourceForm = document.querySelector("#card-form");
const salaryConfigForm = document.querySelector("#salary-config-form");

// Actualizar opciones de plazos según frecuencia (Mensual / Quincenal)
function updateInstallmentOptions(frequency, selectedMonths = 1, selectedPaid = 0) {
  const monthsSelect = document.querySelector("#purchase-months");
  const paidSelect = document.querySelector("#purchase-paid-months");
  const labelTotal = document.querySelector("#label-total-installments");
  const labelPaid = document.querySelector("#label-paid-installments");
  
  const isQuincenal = frequency === "quincenal";
  if (labelTotal) labelTotal.textContent = isQuincenal ? "Quincenas totales" : "Meses totales";
  if (labelPaid) labelPaid.textContent = isQuincenal ? "Quincenas ya pagadas" : "Meses ya pagados";

  const totalOptions = isQuincenal 
    ?
    :;

  monthsSelect.innerHTML = totalOptions.map(num => 
    `<option value="${num}" ${num === Number(selectedMonths) ? "selected" : ""}>${num} ${isQuincenal ? (num === 1 ? "quincena" : "quincenas") : (num === 1 ? "mes" : "meses")}</option>`
  ).join("");

  const maxTotal = Number(monthsSelect.value) || 1;
  paidSelect.innerHTML = Array.from({ length: maxTotal }, (_, i) => 
    `<option value="${i}" ${i === Number(selectedPaid) ? "selected" : ""}>${i} ${isQuincenal ? "pagadas" : "pagados"}</option>`
  ).join("");
}

document.querySelector("#purchase-frequency").addEventListener("change", (e) => {
  updateInstallmentOptions(e.target.value);
});

document.querySelector("#purchase-months").addEventListener("change", (e) => {
  const maxTotal = Number(e.target.value) || 1;
  const paidSelect = document.querySelector("#purchase-paid-months");
  const currentPaid = Math.min(Number(paidSelect.value) || 0, maxTotal - 1);
  const isQuincenal = document.querySelector("#purchase-frequency").value === "quincenal";
  paidSelect.innerHTML = Array.from({ length: maxTotal }, (_, i) => 
    `<option value="${i}" ${i === currentPaid ? "selected" : ""}>${i} ${isQuincenal ? "pagadas" : "pagados"}</option>`
  ).join("");
});

function closePurchaseModal() { purchaseModal.classList.remove("is-open"); purchaseModal.setAttribute("aria-hidden", "true"); editingPurchaseId = null; }
function openPurchaseModal(purchase = null) { 
  editingPurchaseId = purchase?.id ?? null; 
  purchaseForm.reset(); 
  document.querySelector("#modal-title").textContent = purchase ? "Editar compra" : "Registrar compra"; 
  document.querySelector("#save-purchase").textContent = purchase ? "Guardar cambios" : "Guardar compra"; 
  
  const frequency = purchase?.frecuenciaPago || "mensual";
  document.querySelector("#purchase-frequency").value = frequency;
  updateInstallmentOptions(frequency, purchase?.mesesSinIntereses || 1, purchase?.mensualidadesPagadas || 0);

  if (purchase) { 
    document.querySelector("#purchase-name").value = purchase.nombre; 
    document.querySelector("#purchase-amount").value = purchase.montoTotal; 
    document.querySelector("#purchase-card").value = purchase.tarjeta; 
    document.querySelector("#fechaPrimerPago").value = purchase.fechaPrimerPago || getDefaultFirstPaymentDate(startOfToday());
  } else {
    document.querySelector("#fechaPrimerPago").value = getDefaultFirstPaymentDate(startOfToday());
  }
  purchaseModal.classList.add("is-open"); 
  purchaseModal.setAttribute("aria-hidden", "false"); 
  document.querySelector("#purchase-name").focus(); 
}

function closeSourceModal() { sourceModal.classList.remove("is-open"); sourceModal.setAttribute("aria-hidden", "true"); editingSourceName = null; }
function toggleSourceFields() { const loan = document.querySelector("#source-type").value === "prestamo"; document.querySelector("#credit-fields").hidden = loan; document.querySelector("#loan-fields").hidden = !loan; document.querySelector("#card-cutoff").required = !loan; document.querySelector("#card-due").required = !loan; document.querySelector("#loan-payment-days").required = loan; }

function openSourceModal(source = null) { 
  editingSourceName = source?.nombre ?? null; 
  sourceForm.reset(); 
  document.querySelector("#card-modal-title").textContent = source ? "Editar fuente" : "Registrar fuente"; 
  document.querySelector("#save-card").textContent = source ? "Guardar cambios" : "Guardar fuente"; 
  
  const nameInput = document.querySelector("#card-name");
  nameInput.disabled = false;
  
  if (source) { 
    nameInput.value = source.nombre; 
    document.querySelector("#source-type").value = source.tipo; 
    document.querySelector("#card-cutoff").value = source.diaCorte; 
    document.querySelector("#card-due").value = source.diaLimitePago; 
    document.querySelector("#loan-payment-days").value = source.diasPago.join(", "); 
  } 
  toggleSourceFields(); 
  sourceModal.classList.add("is-open"); 
  sourceModal.setAttribute("aria-hidden", "false"); 
  nameInput.focus(); 
}

// Botones y eventos de apertura/cierre
document.querySelector("#open-purchase-modal").addEventListener("click", () => openPurchaseModal()); 
document.querySelector("#manage-add-purchase").addEventListener("click", () => openPurchaseModal()); 
document.querySelector("#close-purchase-modal").addEventListener("click", closePurchaseModal); 
document.querySelector("#cancel-purchase").addEventListener("click", closePurchaseModal); 
purchaseModal.addEventListener("click", (event) => { if (event.target === purchaseModal) closePurchaseModal(); });

document.querySelector("#open-card-modal").addEventListener("click", () => openSourceModal()); 
document.querySelector("#close-card-modal").addEventListener("click", closeSourceModal); 
document.querySelector("#cancel-card").addEventListener("click", closeSourceModal); 
sourceModal.addEventListener("click", (event) => { if (event.target === sourceModal) closeSourceModal(); }); 
document.querySelector("#source-type").addEventListener("change", toggleSourceFields);

document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closePurchaseModal(); closeSourceModal(); } }); 

// Navegación entre Pestañas
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => { 
  document.querySelectorAll(".tab").forEach((item) => { 
    const active = item === tab; 
    item.classList.toggle("is-active", active); 
    item.setAttribute("aria-selected", active); 
  }); 
  document.querySelectorAll(".view").forEach((view) => { 
    view.hidden = view.id !== tab.dataset.view; 
  }); 
}));

document.querySelector("#manage-table-body").addEventListener("click", (event) => { 
  const button = event.target.closest("button[data-action]"); 
  if (!button) return; 
  const index = purchases.findIndex(({ id }) => id === button.dataset.id); 
  if (index < 0) return; 
  if (button.dataset.action === "edit") openPurchaseModal(purchases[index]); 
  if (button.dataset.action === "delete" && window.confirm(`¿Eliminar “${purchases[index].nombre}”?`)) { 
    purchases.splice(index, 1); 
    saveToCloud(); 
    render(); 
  } 
});

purchaseForm.addEventListener("submit", (event) => { 
  event.preventDefault(); 
  const data = new FormData(purchaseForm);
  const amount = Number(data.get("monto"));
  const frequency = data.get("frecuenciaPago") || "mensual";
  const months = Number(data.get("meses"));
  const paid = Number(data.get("mensualidadesPagadas"));
  const fechaPrimerPago = data.get("fechaPrimerPago");
  const error = document.querySelector("#form-error"); 

  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(months) || months < 1 || !Number.isInteger(paid) || paid < 0 || paid >= months) { 
    error.textContent = "Revisa el monto y los plazos pagados."; 
    return; 
  } 

  const changes = { 
    nombre: data.get("nombre").trim(), 
    montoTotal: amount, 
    tarjeta: data.get("tarjeta"), 
    frecuenciaPago: frequency,
    mesesSinIntereses: months, 
    mensualidadesPagadas: paid, 
    fechaPrimerPago: fechaPrimerPago 
  }; 

  const index = purchases.findIndex(({ id }) => id === editingPurchaseId); 
  if (index >= 0) {
    purchases[index] = new Compra({ ...purchases[index], ...changes, saldoRestante: amount }); 
  } else {
    purchases.push(new Compra(changes)); 
  }

  saveToCloud(); 
  error.textContent = ""; 
  closePurchaseModal(); 
  render(); 
});

document.querySelector("#manage-cards-table-body").addEventListener("click", (event) => { 
  const button = event.target.closest("button[data-source-action]"); 
  if (!button || button.disabled) return; 
  const index = cards.findIndex(({ nombre }) => nombre === button.dataset.sourceName); 
  if (index < 0) return; 
  if (button.dataset.sourceAction === "edit") openSourceModal(cards[index]); 
  if (button.dataset.sourceAction === "delete") { 
    const replacement = cards.find((_, current) => current !== index); 
    if (!replacement && purchases.some(({ tarjeta }) => tarjeta === cards[index].nombre)) return; 
    if (replacement) { 
      purchases = purchases.map((purchase) => purchase.tarjeta === cards[index].nombre ? new Compra({ ...purchase, tarjeta: replacement.nombre }) : purchase); 
    } 
    cards.splice(index, 1); 
    saveToCloud(); 
    render(); 
  } 
});

sourceForm.addEventListener("submit", (event) => { 
  event.preventDefault(); 
  const data = new FormData(sourceForm);
  const newName = data.get("nombre").trim();
  const type = data.get("tipo");
  const cutoff = Number(data.get("corte"));
  const due = Number(data.get("limite"));
  const days = normalizePaymentDays(data.get("diasPago"));
  const error = document.querySelector("#card-form-error"); 

  if (!newName || ((type === "tarjeta" || type === "departamental") && (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 31 || !Number.isInteger(due) || due < 1 || due > 31)) || (type === "prestamo" && !days.length)) { 
    error.textContent = "Completa los datos de la fuente correctamente."; 
    return; 
  } 

  if (editingSourceName) {
    const index = cards.findIndex(({ nombre }) => nombre === editingSourceName); 
    if (index >= 0) {
      const nameCollision = cards.some((c, i) => i !== index && c.nombre.toLowerCase() === newName.toLowerCase());
      if (nameCollision) {
        error.textContent = "Ya existe otra fuente con ese nombre.";
        return;
      }

      cards[index] = new FuenteFinanciamiento(newName, cutoff || 15, due || 15, type, days); 

      if (newName !== editingSourceName) {
        purchases = purchases.map((purchase) => 
          purchase.tarjeta === editingSourceName 
            ? new Compra({ ...purchase, tarjeta: newName }) 
            : purchase
        );
      }
    }
  } else {
    if (cards.some((source) => source.nombre.toLowerCase() === newName.toLowerCase())) { 
      error.textContent = "Ya existe una fuente con ese nombre."; 
      return; 
    } 
    cards.push(new FuenteFinanciamiento(newName, cutoff || 15, due || 15, type, days)); 
  }

  saveToCloud(); 
  error.textContent = ""; 
  closeSourceModal(); 
  render(); 
});

// Guardar Sueldo
if (salaryConfigForm) {
  salaryConfigForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(salaryConfigForm);
    salaryConfig = {
      baseSalary: Number(data.get("baseSalary")) || 0,
      currentIncome: Number(data.get("currentIncome")) || 0,
      lastUpdated: new Date().toISOString()
    };
    saveToCloud();
    render();
  });
}

// --- Lógica de Autenticación de Usuarios ---
const authScreen = document.querySelector("#auth-screen");
const mainApp = document.querySelector("#main-app");
const bottomNav = document.querySelector("#bottom-nav");
const authForm = document.querySelector("#auth-form");
const authTitle = document.querySelector("#auth-title");
const authSubmit = document.querySelector("#auth-submit");
const toggleAuthMode = document.querySelector("#toggle-auth-mode");
const authError = document.querySelector("#auth-error");
const userDisplay = document.querySelector("#user-display");
const logoutButton = document.querySelector("#logout-button");
const forgotPasswordBtn = document.querySelector("#forgot-password-btn");

let isRegisterMode = false;

function getAuthErrorMessage(err) {
  const code = err.code || "";
  switch (code) {
    case "auth/invalid-email": return "El formato de correo no es válido.";
    case "auth/user-not-found": case "auth/wrong-password": case "auth/invalid-credential": return "Correo o contraseña incorrectos.";
    case "auth/email-already-in-use": return "Ya existe una cuenta con este correo. Cambia a Iniciar sesión.";
    case "auth/weak-password": return "La contraseña debe tener mínimo 6 caracteres.";
    default: return `Error (${code}): ${err.message || "Verifica tus datos."}`;
  }
}

toggleAuthMode.addEventListener("click", () => {
  isRegisterMode = !isRegisterMode;
  authTitle.textContent = isRegisterMode ? "Crear cuenta" : "Iniciar sesión";
  authSubmit.textContent = isRegisterMode ? "Registrarme" : "Entrar";
  toggleAuthMode.textContent = isRegisterMode ? "¿Ya tienes cuenta? Inicia sesión" : "¿No tienes cuenta? Regístrate";
  if (forgotPasswordBtn) forgotPasswordBtn.style.display = isRegisterMode ? "none" : "block";
  authError.textContent = "";
});

if (forgotPasswordBtn) {
  forgotPasswordBtn.addEventListener("click", async () => {
    const email = document.querySelector("#auth-email").value.trim();
    authError.style.color = "#fca5a5";
    if (!email) {
      authError.textContent = "Ingresa tu correo electrónico arriba para enviarte el enlace.";
      document.querySelector("#auth-email").focus();
      return;
    }
    try {
      authError.style.color = "#a78bfa";
      authError.textContent = "Enviando enlace de recuperación...";
      await auth.sendPasswordResetEmail(email);
      authError.style.color = "#55e6ab";
      authError.textContent = "¡Enlace enviado! Revisa tu correo.";
    } catch (err) {
      authError.style.color = "#fca5a5";
      authError.textContent = `Error: ${err.message}`;
    }
  });
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.querySelector("#auth-email").value.trim();
  const password = document.querySelector("#auth-password").value;
  authError.style.color = "#fca5a5";
  authError.textContent = "";
  authSubmit.disabled = true;
  authSubmit.textContent = "Procesando...";

  try {
    if (isRegisterMode) {
      await auth.createUserWithEmailAndPassword(email, password);
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
  } catch (err) {
    authError.textContent = getAuthErrorMessage(err);
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = isRegisterMode ? "Registrarme" : "Entrar";
  }
});

logoutButton.addEventListener("click", () => {
  auth.signOut();
});

// Escuchar cambios de sesión de usuario en Firebase
auth.onAuthStateChanged((user) => {
  if (unsubscribeFirestore) {
    unsubscribeFirestore();
    unsubscribeFirestore = null;
  }

  if (user) {
    currentUser = user;
    userDocRef = db.collection("users").doc(user.uid);
    authScreen.style.display = "none";
    mainApp.style.display = "block";
    bottomNav.style.display = "flex";
    userDisplay.textContent = user.email || "Mi cuenta";

    const isOwner = user.email && user.email.toLowerCase() === "diazmfernando96@gmail.com";

    unsubscribeFirestore = userDocRef.onSnapshot((snapshot) => {
      if (snapshot.exists) {
        const data = snapshot.data();
        cards = Array.isArray(data.cards) ? data.cards.map((c) => new FuenteFinanciamiento(c.nombre, c.diaCorte, c.diaLimitePago, c.tipo, c.diasPago)) : [];
        purchases = Array.isArray(data.purchases) ? data.purchases.map((d) => new Compra(d)) : [];
        salaryConfig = data.salaryConfig || { baseSalary: 0, currentIncome: 0, lastUpdated: "" };
        
        if (isOwner && purchases.length === 0) {
          cards = [...INITIAL_CARDS];
          const defaultFirstDate = getDefaultFirstPaymentDate(startOfToday());
          purchases = HISTORICAL_PURCHASES.map(({ compra, monto }) => new Compra({ 
            nombre: compra, 
            montoTotal: monto, 
            tarjeta: "BBVA ORO", 
            frecuenciaPago: "mensual",
            mesesSinIntereses: 1, 
            fechaPrimerPago: defaultFirstDate
          }));
          saveToCloud();
        }

        if (data.updatedAt) localStorage.setItem(STORAGE_KEYS.updatedAt, data.updatedAt);
        render();
      } else {
        if (isOwner) {
          cards = [...INITIAL_CARDS];
          const defaultFirstDate = getDefaultFirstPaymentDate(startOfToday());
          purchases = HISTORICAL_PURCHASES.map(({ compra, monto }) => new Compra({ 
            nombre: compra, 
            montoTotal: monto, 
            tarjeta: "BBVA ORO", 
            frecuenciaPago: "mensual",
            mesesSinIntereses: 1, 
            fechaPrimerPago: defaultFirstDate
          }));
        } else {
          cards = [...INITIAL_CARDS];
          purchases = [];
        }
        salaryConfig = { baseSalary: 0, currentIncome: 0, lastUpdated: "" };
        saveToCloud();
        render();
      }
    }, (error) => {
      console.error("Error en Firestore:", error);
    });

  } else {
    currentUser = null;
    userDocRef = null;
    cards = [];
    purchases = [];
    authScreen.style.display = "grid";
    mainApp.style.display = "none";
    bottomNav.style.display = "none";
  }
});

// Inicializaciones
renderPokemonEasterEgg(); 
setInterval(renderPokemonEasterEgg, 30000);
