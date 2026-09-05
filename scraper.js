// AQUEST SCRIPT RASTREJA A GOOGLE MAPS ELS COMERÇOS AMB BAIXA NOTA DE RESSENYES

const { chromium } = require('playwright');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// 1. Inicialitzar Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount)
  });
}
const db = getFirestore();

async function scrapeCity(cityName) {
  console.log(`🔍 Iniciant escombrada exhaustiva i precisa per a: ${cityName}...`);
  const startTime = Date.now();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    locale: 'es-ES',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const page = await context.newPage();

  // Llista ampliada de categories clau en singular
  const categories = [
    'restaurant',
    'bar',
    'cafe',
    'kebab',
    'pizza',
    'food',
    'supermarket',
    'grocery',
    'bazaar',
    'hairdresser',
    'mechanic',
    'clothes',
    'dentist',
    'ice cream',
    'bakery',
    'pastry',
    'accessories',
    'souvenirs',
    'hotel',
    'hostel',
    'wc',
    'toilet',
    'car rental',
    'bike rental',
    'information',
    'travel agency',
    'tours',
    'museum',
    'transport',
    'luggage',
    'lockers',
    'insurance',
    'duty free',
    'exchange',
    'money',
    'tickets',
    'nails',
    'clinic',
    'parking'
  ];

  const criticalStores = new Map();

  for (const category of categories) {
    const query = `${category} en ${cityName}`;
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

    console.log(`\n👉 Cercant [${category}]: "${query}"...`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Acceptar consentiment de cookies si apareix
      const consentBtn = page.locator('button[aria-label*="Aceptar"], button[aria-label*="Accept"], form[action*="consent"] button');
      if (await consentBtn.count() > 0) {
        await consentBtn.first().click().catch(() => { });
        await page.waitForTimeout(1500);
      }

      // Esperar que carregui el panell lateral amb la llista
      const feed = page.locator('div[role="feed"]');
      await feed.waitFor({ timeout: 8000 }).catch(() => { });

      if (await feed.count() > 0) {
        // Scroll progressiu per carregar desenes d'establiments
        for (let scrollStep = 0; scrollStep < 10; scrollStep++) {
          await feed.evaluate(el => el.scrollBy(0, 5000));
          await page.waitForTimeout(1000);
        }
        // Pausa d'estabilització del DOM
        await page.waitForTimeout(1500);
      }

      // Processar tots els articles trobats
      const articles = await page.locator('div[role="article"]').all();
      console.log(`   Analitzant ${articles.length} establiments a la llista.`);

      for (const article of articles) {
        try {
          // 1. Nom del local
          const nameElem = article.locator('.fontHeadlineSmall').first();
          const name = (await nameElem.innerText().catch(() => '')).trim();

          // 2. Extracció robusta universal de la valoració (Rating)
          let rating = null;

          // Format A: Text visible directe al span (ex: "1,8" o "2.0")
          const ratingSpan = article.locator('span[aria-hidden="true"]').first();
          const ratingText = await ratingSpan.innerText().catch(() => '');
          if (ratingText && /^[0-5][,\.][0-9]$/.test(ratingText.trim())) {
            rating = parseFloat(ratingText.replace(',', '.'));
          }

          // Format B: aria-label a elements interns amb icona d'estrelles
          if (rating === null) {
            const starElem = article.locator('span[aria-label*="estrella"], span[aria-label*="star"], span[role="img"]').first();
            const starLabel = await starElem.getAttribute('aria-label').catch(() => '');
            const match = starLabel ? starLabel.match(/([0-5][,\.][0-9])/) : null;
            if (match) rating = parseFloat(match[1].replace(',', '.'));
          }

          // Format C: aria-label complet de l'enllaç principal de l'article
          const linkElem = article.locator('a').first();
          const href = await linkElem.getAttribute('href').catch(() => '');
          if (rating === null) {
            const linkLabel = await linkElem.getAttribute('aria-label').catch(() => '');
            const matchLink = linkLabel ? linkLabel.match(/([0-5][,\.][0-9])\s*(estrellas|stars|estrelles)/i) : null;
            if (matchLink) rating = parseFloat(matchLink[1].replace(',', '.'));
          }

          // 3. Filtrar estrictament: nota <= 2.0
          if (name && rating !== null && href && rating <= 2.0) {
            const coordsMatch = href.match(/!3d([0-9.-]+)!4d([0-9.-]+)/);
            const placeIdMatch = href.match(/1s(0x[0-9a-fA-F]+:[0-9a-fA-F]+)/);

            if (coordsMatch) {
              const placeId = placeIdMatch ? placeIdMatch[1] : `store_${Buffer.from(name).toString('hex').slice(0, 16)}`;

              if (!criticalStores.has(placeId)) {
                criticalStores.set(placeId, {
                  id: placeId,
                  name: name,
                  rating: rating,
                  latitude: parseFloat(coordsMatch[1]),
                  longitude: parseFloat(coordsMatch[2]),
                  city: cityName,
                  category: category,
                  googleMapsUrl: href
                });
                console.log(`   🚨 CRÍTIC TROBAT: ${name} (${rating}★) [${category}]`);
              }
            }
          }
        } catch (e) {
          // Continuar amb el següent establiment
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Avís cercant ${category}: ${err.message}`);
    }
  }

  await browser.close();

  // 4. Pujada a Firebase Firestore en un sol batch atòmic
  console.log(`\n💾 Pujant ${criticalStores.size} comerços crítics a Firebase Firestore...`);
  const batch = db.batch();
  for (const [id, storeData] of criticalStores.entries()) {
    const docRef = db.collection('critical_stores').doc(id);
    batch.set(docRef, {
      ...storeData,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  // Guardar el cursor/estat de progrés de manera atòmica al mateix batch
  console.log(`💾 Afegint progrés del scraper a Firestore per a: ${cityName}...`);
  const progressRef = db.collection('_system_state').doc('scraper_progress');
  batch.set(progressRef, {
    last_completed_target: cityName,
    updated_at: FieldValue.serverTimestamp(),
    completed_count: FieldValue.increment(1)
  }, { merge: true });

// Actualitzar l'estat de la ciutat a 'completed' a scanned_cities
  const citySnapshot = await db.collection('scanned_cities')
    .where('target_name', '==', cityName)
    .get();

  if (!citySnapshot.empty) {
    citySnapshot.forEach((doc) => {
      batch.set(doc.ref, {
        status: 'completed',
        completed_at: FieldValue.serverTimestamp(),
        critical_count: criticalStores.size
      }, { merge: true });
    });
  } else {
    // Si la ciutat s'ha llançat per ID directa
    const fallbackId = cityName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    batch.set(db.collection('scanned_cities').doc(fallbackId), {
      target_name: cityName,
      status: 'completed',
      completed_at: FieldValue.serverTimestamp(),
      critical_count: criticalStores.size
    }, { merge: true });
  }
  
  await batch.commit();
  const totalMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ Escombrada finalitzada per a ${cityName} en ${totalMinutes} minuts: ${criticalStores.size} comerços crítics desats a Firestore.`);
}

// Lectura de la ciutat com a argument de línia d'ordres
const targetCity = process.argv[2] || 'Mataró';
scrapeCity(targetCity).catch(console.error);
