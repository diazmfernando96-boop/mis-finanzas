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

    // Identificar si es tu cuenta personal
    const isOwner = user.email && user.email.toLowerCase() === "diazmfernando96@gmail.com";

    // Escucha en tiempo real de los datos exclusivos del usuario
    unsubscribeFirestore = userDocRef.onSnapshot((snapshot) => {
      if (snapshot.exists) {
        const data = snapshot.data();
        cards = Array.isArray(data.cards) ? data.cards.map((c) => new FuenteFinanciamiento(c.nombre, c.diaCorte, c.diaLimitePago, c.tipo, c.diasPago)) : [];
        purchases = Array.isArray(data.purchases) ? data.purchases.map((d) => new Compra(d)) : [];
        
        // Si es TU cuenta y está vacía, restaura tus compras personales
        if (isOwner && purchases.length === 0) {
          cards = [...INITIAL_CARDS];
          purchases = HISTORICAL_PURCHASES.map(({ compra, monto }) => new Compra({ nombre: compra, montoTotal: monto, tarjeta: "BBVA ORO", mesesSinIntereses: 1 }));
          saveToCloud();
        }

        if (data.updatedAt) localStorage.setItem(STORAGE_KEYS.updatedAt, data.updatedAt);
        render();
      } else {
        if (isOwner) {
          // Tu cuenta recibe tus tarjetas y compras históricas
          cards = [...INITIAL_CARDS];
          purchases = HISTORICAL_PURCHASES.map(({ compra, monto }) => new Compra({ nombre: compra, montoTotal: monto, tarjeta: "BBVA ORO", mesesSinIntereses: 1 }));
        } else {
          // Cualquier otro usuario inicia 100% en ceros (compras vacías)
          cards = [...INITIAL_CARDS];
          purchases = [];
        }
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
