const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_PAGE_CONCURRENCY = 4;
const searchCache = new Map();
const searchesInFlight = new Map();

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
    res.sendFile(path.join(__dirname, 'indexOriginal.html'));
});

app.get('/api/cars/:make/:model/analysis', async (req, res) => {
    const { make, model } = req.params;
    const searchUrl = `https://www.nettiauto.com/${make}/${model}`;

    try {
        const state = await getSearchResults(searchUrl, make, model);
        res.json({
            success: true,
            status: state.status,
            scannedSourcePages: state.scannedSourcePages,
            totalSourcePages: state.totalSourcePages,
            count: state.reportedCount || state.cars.length,
            analysis: state.analysis,
            error: state.error
        });
    } catch (error) {
        console.error('Analysis status error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to start or retrieve the search analysis.'
        });
    }
});

function parseSearchResults(html, make, model) {
    const $ = cheerio.load(html);
    let cars = [];
    let reportedCount = null;

    $('script[type="application/ld+json"]').each((_, element) => {
        try {
            const jsonData = JSON.parse($(element).html());
            const types = Array.isArray(jsonData['@type']) ? jsonData['@type'] : [jsonData['@type']];

            if (types.includes('SearchResultsPage') && jsonData.mainEntity) {
                const itemListElements = jsonData.mainEntity.itemListElement || [];
                reportedCount = Number(jsonData.mainEntity.numberOfItems) || reportedCount;

                cars = itemListElements.map(element => {
                    const item = element.item || {};
                    const priceValue = item.offers?.price != null ? Number(item.offers.price) : null;
                    const mileageValue = item.mileageFromOdometer?.value;
                    return {
                        position: element.position,
                        name: item.name || 'N/A',
                        brand: item.brand || make,
                        model: item.model || model,
                        year: item.name ? extractYear(item.name) : 'N/A',
                        price: item.offers ? `${item.offers.price} ${item.offers.priceCurrency}` : 'N/A',
                        priceValue: Number.isFinite(priceValue) ? priceValue : null,
                        currency: item.offers ? item.offers.priceCurrency : 'EUR',
                        mileageKm: mileageValue != null && Number.isFinite(Number(mileageValue)) ? Number(mileageValue) : null,
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
        } catch (error) {
            // Ignore invalid JSON-LD blocks and continue looking for a search result block.
        }
    });

    return { cars, reportedCount };
}

function findLastSearchPage(html, searchUrl, reportedCount, firstPageCount) {
    const $ = cheerio.load(html);
    const baseUrl = new URL(searchUrl);
    let lastPage = 1;

    $('a[href], link[rel="last"][href]').each((_, element) => {
        try {
            const candidate = new URL($(element).attr('href'), baseUrl);
            if (candidate.hostname === baseUrl.hostname
                && candidate.pathname.replace(/\/$/, '') === baseUrl.pathname.replace(/\/$/, '')) {
                lastPage = Math.max(lastPage, Number(candidate.searchParams.get('page')) || 1);
            }
        } catch (error) {
            // Ignore malformed pagination links.
        }
    });

    if (lastPage === 1 && reportedCount && firstPageCount && reportedCount > firstPageCount) {
        lastPage = Math.ceil(reportedCount / firstPageCount);
    }

    return lastPage;
}

async function fetchNettiautoPage(searchUrl, page) {
    const pageUrl = new URL(searchUrl);
    if (page > 1) {
        pageUrl.searchParams.set('page', String(page));
    }

    const response = await axios.get(pageUrl.toString(), {
        timeout: 20000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'fi-FI,fi;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    });

    return response.data;
}

function createSearchState(searchKey, searchUrl, firstPageResults, firstPageHtml) {
    const lastPage = findLastSearchPage(
        firstPageHtml,
        searchUrl,
        firstPageResults.reportedCount,
        firstPageResults.cars.length
    );
    const state = {
        searchKey,
        carsByKey: new Map(),
        cars: [],
        reportedCount: firstPageResults.reportedCount,
        totalSourcePages: lastPage,
        scannedSourcePages: 1,
        status: 'analyzing',
        analysis: null,
        error: null,
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
        listeners: new Set()
    };

    addSearchCars(state, firstPageResults.cars);
    return state;
}

function addSearchCars(state, cars) {
    for (const car of cars) {
        const key = car.url || (car.position != null
            ? `position:${car.position}`
            : `${car.name}|${car.priceValue}|${car.mileageKm}`);
        if (!state.carsByKey.has(key)) {
            state.carsByKey.set(key, car);
        }
    }

    state.cars = [...state.carsByKey.values()].sort((a, b) => {
        if (Number.isFinite(a.position) && Number.isFinite(b.position)) {
            return a.position - b.position;
        }
        return 0;
    });
}

function notifySearchState(state) {
    for (const listener of state.listeners) {
        listener();
    }
    state.listeners.clear();
}

function waitForSearchStateChange(state) {
    return new Promise(resolve => {
        state.listeners.add(resolve);
    });
}

function summarizeCars(cars) {
    const prices = cars
        .map(car => car.priceValue)
        .filter(value => Number.isFinite(value) && value >= 0);
    const mileages = cars
        .map(car => car.mileageKm)
        .filter(value => Number.isFinite(value) && value >= 0);
    const pricedCars = cars.filter(car => Number.isFinite(car.priceValue) && car.priceValue >= 0);

    return {
        averagePrice: prices.length
            ? prices.reduce((sum, value) => sum + value, 0) / prices.length
            : null,
        averageMileageKm: mileages.length
            ? mileages.reduce((sum, value) => sum + value, 0) / mileages.length
            : null,
        cheapest: pricedCars.reduce(
            (cheapest, car) => car.priceValue < cheapest.priceValue ? car : cheapest,
            pricedCars[0] || null
        ),
        mostExpensive: pricedCars.reduce(
            (mostExpensive, car) => car.priceValue > mostExpensive.priceValue ? car : mostExpensive,
            pricedCars[0] || null
        )
    };
}

async function finishSearchAnalysis(state, searchUrl, make, model) {
    let failedPages = 0;

    for (let batchStart = 2; batchStart <= state.totalSourcePages; batchStart += SEARCH_PAGE_CONCURRENCY) {
        const pageNumbers = Array.from(
            { length: Math.min(SEARCH_PAGE_CONCURRENCY, state.totalSourcePages - batchStart + 1) },
            (_, index) => batchStart + index
        );
        const pageResults = await Promise.allSettled(
            pageNumbers.map(async page => {
                const html = await fetchNettiautoPage(searchUrl, page);
                return parseSearchResults(html, make, model).cars;
            })
        );

        for (let index = 0; index < pageResults.length; index++) {
            const result = pageResults[index];
            if (result.status === 'fulfilled') {
                addSearchCars(state, result.value);
            } else {
                failedPages++;
                console.error(`Failed to fetch Nettiauto source page ${pageNumbers[index]} for ${make}/${model}:`, result.reason.message);
            }
            state.scannedSourcePages++;
        }
        state.expiresAt = Date.now() + SEARCH_CACHE_TTL_MS;
        notifySearchState(state);
    }

    if (failedPages > 0) {
        throw new Error(`Could not fetch ${failedPages} Nettiauto result page(s); full analysis is incomplete.`);
    }

    state.reportedCount = state.cars.length;
    state.analysis = summarizeCars(state.cars);
    state.status = 'complete';
    state.expiresAt = Date.now() + SEARCH_CACHE_TTL_MS;
    notifySearchState(state);
}

async function initializeSearch(searchUrl, make, model) {
    const firstPageHtml = await fetchNettiautoPage(searchUrl, 1);
    const firstPageResults = parseSearchResults(firstPageHtml, make, model);

    if (firstPageResults.cars.length === 0) {
        throw new Error('No car listings found in the Nettiauto search page schema.');
    }

    const cacheKey = `${make.toLowerCase()}/${model.toLowerCase()}`;
    const state = createSearchState(cacheKey, searchUrl, firstPageResults, firstPageHtml);
    searchCache.set(cacheKey, state);

    if (state.totalSourcePages === 1) {
        state.analysis = summarizeCars(state.cars);
        state.reportedCount = state.cars.length;
        state.status = 'complete';
    } else {
        finishSearchAnalysis(state, searchUrl, make, model).catch(error => {
            state.error = error.message;
            state.status = 'failed';
            state.expiresAt = Date.now() + SEARCH_CACHE_TTL_MS;
            notifySearchState(state);
            console.error(`Search analysis failed for ${make}/${model}:`, error.message);
        });
    }

    return state;
}

async function getSearchResults(searchUrl, make, model) {
    const cacheKey = `${make.toLowerCase()}/${model.toLowerCase()}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (cached.status === 'analyzing' || cached.expiresAt > Date.now()) && cached.status !== 'failed') {
        return cached;
    }
    if (cached) {
        searchCache.delete(cacheKey);
    }

    if (searchesInFlight.has(cacheKey)) {
        return searchesInFlight.get(cacheKey);
    }

    const searchPromise = initializeSearch(searchUrl, make, model);
    searchesInFlight.set(cacheKey, searchPromise);

    try {
        return await searchPromise;
    } finally {
        searchesInFlight.delete(cacheKey);
    }
}

app.get('/api/cars/:make/:model', async (req, res) => {
    const { make, model } = req.params;
    const url = `https://www.nettiauto.com/${make}/${model}`;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));

    try {
        const state = await getSearchResults(url, make, model);
        const end = page * limit;

        while (state.cars.length < end && state.status === 'analyzing') {
            await waitForSearchStateChange(state);
        }

        const count = state.status === 'complete'
            ? state.cars.length
            : state.reportedCount || state.cars.length;
        const totalPages = Math.max(1, Math.ceil(count / limit));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * limit;
        const paginatedData = state.cars.slice(start, start + limit);

        res.json({
            success: true,
            page: safePage,
            limit,
            totalPages,
            count,
            analysisStatus: state.status,
            analysisProgress: {
                scannedSourcePages: state.scannedSourcePages,
                totalSourcePages: state.totalSourcePages
            },
            analysisError: state.error,
            analysis: state.analysis,
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
