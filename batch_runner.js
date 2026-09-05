// AUTOMATITZACIÓ DEL RASTREIG DE COMERÇOS DE CIUTATS PER A LA BASE DE DADES
// AQUEST SCRIPT GESTIONA LA CUA DINÀMICA DIRECTAMENT DES DE FIRESTORE (scanned_cities)
// CRIDA A SCRAPER.JS PASSANT EL DESTÍ COM A ARGUMENT
const { spawn } = require('child_process');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// 1. Inicialització de Firebase Admin SDK
let db = null;
const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

if (serviceAccountKey) {
    try {
        const serviceAccount = JSON.parse(serviceAccountKey);
        if (getApps().length === 0) {
            initializeApp({
                credential: cert(serviceAccount)
            });
        }
        db = getFirestore();
    } catch (err) {
        console.error("❌ Error inicialitzant Firebase Admin en batch_runner:", err.message);
    }
} else {
    try {
        // Fallback per a proves locals si existeix l'arxiu json
        const localKey = require('./firebase-key.json');
        if (getApps().length === 0) {
            initializeApp({
                credential: cert(localKey)
            });
        }
        db = getFirestore();
    } catch {
        console.error("❌ Error crític: Cal configurar FIREBASE_SERVICE_ACCOUNT a les variables d'entorn.");
        process.exit(1);
    }
}

// 2. Executar scraper.js per a un destí retornant el resultat
function runScraperForTarget(target, index, total) {
    return new Promise((resolve) => {
        console.log(`\n======================================================`);
        console.log(`📍 [${index + 1}/${total}] Processant destí: "${target}"`);
        console.log(`======================================================`);

        const scraper = spawn('node', ['scraper.js', `"${target}"`], {
            stdio: 'inherit',
            shell: true
        });

        scraper.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Completat amb èxit: "${target}"`);
                resolve({ success: true, code });
            } else {
                console.warn(`⚠️ Finalitzat amb avís o codi d'error (${code}) a: "${target}"`);
                resolve({ success: false, code });
            }
        });

        scraper.on('error', (err) => {
            console.error(`❌ Error executant el scraper per a "${target}":`, err.message);
            resolve({ success: false, error: err.message });
        });
    });
}

// 3. Orquestrador principal del lot
async function startBatch() {
    const BATCH_LIMIT = 15; // Límit per execució per controlar els cicles

    console.log("⏳ Consultant destins pendents a la col·lecció 'scanned_cities'...");

    let snapshot;
    try {
        snapshot = await db.collection('scanned_cities')
            .where('status', 'in', ['pending', 'in_progress'])
            .orderBy('user_hits', 'desc')
            .limit(BATCH_LIMIT)
            .get();
    } catch (err) {
        console.error("❌ Error obtenint destins de Firestore:", err.message);
        // Si cal un índex compost (status + user_hits), Firestore ho indicarà en l'error
        process.exit(1);
    }

    if (snapshot.empty) {
        console.log("ℹ️ No pending targets found. Exiting gracefully.");
        process.exit(0);
    }

    const pendingTargets = snapshot.docs.map(doc => ({
        id: doc.id,
        ref: doc.ref,
        name: doc.data().target_name || doc.id,
        user_hits: doc.data().user_hits || 0
    }));

    const total = pendingTargets.length;
    console.log(`🚀 S'han trobat ${total} destins pendents. Iniciant processament per prioritat de demanda...`);
    const globalStart = Date.now();

    for (let i = 0; i < total; i++) {
        const item = pendingTargets[i];

        // 3.1. Marcar l'estat com a "in_progress" abans de començar
        // (ELIMINAT per evitar bloquejos si el job es talla a mig fer)
       
        // 3.2. Execució de l'scraping
        const result = await runScraperForTarget(item.name, i, total);

        // 3.3. Actualitzar estat final del destí
        try {
            if (result.success) {
                await item.ref.update({
                    status: 'completed',
                    last_scanned_at: FieldValue.serverTimestamp()
                });

                
            } else {
                await item.ref.update({
                    status: 'failed',
                    error_message: result.error || `Exit code ${result.code}`,
                    last_attempt_at: FieldValue.serverTimestamp()
                });
            }
        } catch (updateErr) {
            console.error(`❌ Error actualitzant l'estat a Firestore per a "${item.name}":`, updateErr.message);
        }
    }

    const totalMin = ((Date.now() - globalStart) / 1000 / 60).toFixed(1);
    console.log(`\n🎉 LOT FINALITZAT: S'han processat ${total} destins en ${totalMin} minuts.`);
}

startBatch();
