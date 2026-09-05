const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");

// Configura tu usuario y repositorio
const GITHUB_OWNER = "oriolrp79";
const GITHUB_REPO = "StoreScamAlert-ScrapeBot";
const GITHUB_WORKFLOW_ID = "scrape_single.yml";
// Se recomienda configurar mediante: firebase functions:secrets:set GITHUB_TOKEN
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 

exports.triggerSingleScrape = onDocumentCreated("scanned_cities/{cityId}", async (event) => {
    const data = event.data.data();
    if (!data) return;

    const targetCity = data.target_name || data.city_name;
    if (!targetCity) {
        logger.warn("Documento creado sin target_name válido:", event.params.cityId);
        return;
    }

    logger.info(`Nueva ciudad registrada: ${targetCity}. Despachando workflow express en GitHub...`);

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_ID}/dispatches`;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Accept": "application/vnd.github+json",
                "Authorization": `Bearer ${GITHUB_TOKEN}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
                "User-Agent": "Firebase-Cloud-Function"
            },
            body: JSON.stringify({
                ref: "main",
                inputs: {
                    target_city: targetCity
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`GitHub API respondió con status ${response.status}: ${errorText}`);
        }

        logger.info(`Workflow lanzado con éxito para ${targetCity}`);
    } catch (error) {
        logger.error("Error al disparar el workflow de GitHub:", error);
    }
});
