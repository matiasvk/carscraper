const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/cars/:make/:model', async (req, res) => {
    const { make, model } = req.params;
    const url = `https://www.nettiauto.com/${make}/${model}`;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 25));

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'fi-FI,fi;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        const $ = cheerio.load(response.data);
        let carsData = [];

        // Find all JSON-LD script tags on the page
        $('script[type="application/ld+json"]').each((_, element) => {
            try {
                const jsonData = JSON.parse($(element).html());
                
                // Look for the schema object that holds the ItemList of cars
                if (jsonData['@type'] && jsonData['@type'].includes('SearchResultsPage') && jsonData.mainEntity) {
                    const itemListElements = jsonData.mainEntity.itemListElement || [];
                    
                    carsData = itemListElements.map(element => {
                        const item = element.item || {};
                        return {
                            position: element.position,
                            name: item.name || 'N/A',
                            brand: item.brand || make,
                            model: item.model || model,
                            year: item.name ? extractYear(item.name) : 'N/A',
                            price: item.offers ? `${item.offers.price} ${item.offers.priceCurrency}` : 'N/A',
                            priceValue: item.offers ? item.offers.price : null,
                            currency: item.offers ? item.offers.priceCurrency : 'EUR',
                            mileageKm: item.mileageFromOdometer ? item.mileageFromOdometer.value : 0,
                            fuelType: item.fuelType || 'N/A',
                            transmission: item.vehicleTransmission || 'N/A',
                            bodyType: item.bodyType || 'N/A',
                            color: item.color || 'N/A',
                            image: item.image || null,
                            url: item.url || null,
                            vin: item.vehicleIdentificationNumber || null
                        };
                    });
                }
            } catch (e) {
                // Ignore script tags that aren't valid JSON or don't match our structure
            }
        });

        if (carsData.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No car listings found in the page schema. The URL might be invalid or layout changed.'
            });
        }

        const totalPages = Math.max(1, Math.ceil(carsData.length / limit));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * limit;
        const paginatedData = carsData.slice(start, start + limit);

        res.json({
            success: true,
            page: safePage,
            limit,
            totalPages,
            count: carsData.length,
            data: paginatedData
        });

    } catch (error) {
        console.error('Scraping error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch or parse data from Nettiauto.'
        });
    }
});

// Helper function to extract the year from strings like "BMW 325 Bensiini (2006)"
function extractYear(nameString) {
    const match = nameString.match(/\((\d{4})\)/);
    return match ? match[1] : 'N/A';
}

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});