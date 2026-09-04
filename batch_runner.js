// AUTOMATITZACIÓ DEL RASTREIG DE COMERÇOS DE CIUTATS PER A LA BASE DE DADES
// AQUEST SCRIPT LLEGEIX LA LLISTA DE CIUTATS I LLOCS QUE HI HA A TARGETS.TXT
//AQUEST SCRIPT CRIDA A SCRAPER.JS, QUE ÉS EL QUE FA EL RASTREIG A GOOGLE MAPS
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const TARGETS_FILE = path.join(__dirname, 'targets.txt');

// Inicialitzar Firebase Admin SDK si tenim les credencials a l'entorn
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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
    console.warn("⚠️ Advertència: FIREBASE_SERVICE_ACCOUNT no està definit a les variables d'entorn. S'iniciarà des del principi.");
}


// 1. Leer y limpiar la lista del archivo de texto
function loadTargets() {
    if (!fs.existsSync(TARGETS_FILE)) {
        console.error(`❌ No se encontró el archivo: ${TARGETS_FILE}`);
        process.exit(1);
    }

    const raw = fs.readFileSync(TARGETS_FILE, 'utf-8');
    return raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
}

// 2. Ejecutar scraper.js para una ubicación de forma síncrona/promesa
function runScraperForTarget(target, index, total) {
    return new Promise((resolve) => {
        console.log(`\n======================================================`);
        console.log(`📍 [${index + 1}/${total}] Procesando: "${target}"`);
        console.log(`======================================================`);

        const scraper = spawn('node', ['scraper.js', `"${target}"`], {
            stdio: 'inherit',
            shell: true
        });

        scraper.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Completado con éxito: "${target}"`);
            } else {
                console.warn(`⚠️ Finalizado con código de aviso/error (${code}) en: "${target}"`);
            }
            resolve();
        });

        scraper.on('error', (err) => {
            console.error(`❌ Error lanzando el scraper para "${target}":`, err.message);
            resolve();
        });
    });
}

// 3. Bucle secuencial uno a uno
async function startBatch() {
    const targets = loadTargets();
    const total = targets.length;

    if (total === 0) {
        console.log('ℹ️ No hay ubicaciones válidas en targets.txt.');
        return;
    }

    let startIndex = 0;

    if (db) {
        try {
            console.log("⏳ Consultant l'estat del scraper a Firestore (col·lecció _system_state, document scraper_progress)...");
            const docRef = db.collection('_system_state').doc('scraper_progress');
            const docSnap = await docRef.get();

            if (docSnap.exists) {
                const data = docSnap.data();
                const lastCompleted = data.last_completed_target;
                if (lastCompleted) {
                    const normalizedLast = lastCompleted.trim().toLowerCase();
                    const idx = targets.findIndex(t => t.trim().toLowerCase() === normalizedLast);
                    if (idx !== -1) {
                        if (idx === total - 1) {
                            console.log(`ℹ️ L'últim destí completat és el final de la llista: "${lastCompleted}".`);
                            console.log(`🔄 Reiniciant el lot des del principi.`);
                            startIndex = 0;
                        } else {
                            startIndex = idx + 1;
                            console.log(`⏭️ Reprenent des del destí [${startIndex + 1}/${total}]: "${targets[startIndex]}" (l'últim completat va ser "${lastCompleted}").`);
                        }
                    } else {
                        console.log(`⚠️ L'últim destí completat ("${lastCompleted}") no s'ha trobat a targets.txt. S'iniciarà des del principi.`);
                    }
                }
            } else {
                console.log("ℹ️ No s'ha trobat estat anterior a Firestore. S'iniciarà des del principi.");
            }
        } catch (err) {
            console.error("❌ Error en recuperar l'estat de progrés de Firestore:", err.message);
            console.log("⚠️ Continuant des del principi per defecte.");
        }
    }

    console.log(`🚀 Iniciando lote de rastreo para ${total - startIndex} de ${total} ubicaciones...`);
    const globalStart = Date.now();

    for (let i = startIndex; i < total; i++) {
        await runScraperForTarget(targets[i], i, total);
    }

    const totalMin = ((Date.now() - globalStart) / 1000 / 60).toFixed(1);
    console.log(`\n🎉 LOTE FINALIZADO: Se procesaron las ubicaciones restantes en ${totalMin} minutos.`);
}

startBatch();
