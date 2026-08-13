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

function normalizePaymentDays(days) { 
  return [...new Set((Array.isArray(days) ? days : String(days).split(",")).map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))].sort((a, b) => a - b); 
}

const readStorage = (
  
