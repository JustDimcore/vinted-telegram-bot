import Logger from "../utils/logger.js";
import { fetchCatalogItems } from "../api/fetchCatalogItems.js";
import { fetchItemDetail } from "../api/fetchItemDetail.js";
import { VintedItem } from "../entities/vinted_item.js";
import { buildApiFiltersFromUrl, hasAnyFilter, filterItemsByUrl, getDomainFromUrl } from "./url_service.js";
import ConfigurationManager from "../utils/config_manager.js";
import crud from "../crud.js";

// How many items one catalog request pulls. With an interval of tens of seconds a
// single subscription does not gain that many items, and a larger page would only
// transfer data that deduplication throws away anyway.
const ITEMS_PER_REQUEST = 20;
// After a rate limit the interval is multiplied until a request succeeds again.
const RATE_LIMIT_BACKOFF_FACTOR = 2;
const MAX_BACKOFF_MULTIPLIER = 10;
const HTTP_RATE_LIMIT = 429;
// New subscriptions are spread over the interval instead of all firing at once.
const STAGGER_STEP_MS = 1500;

/**
 * Watches every subscription separately and reports new items.
 *
 * Every subscription has its own timer and its own memory of the last seen ID, so they
 * are independent and a failure of one does not stop the others. Filtering is done by
 * Vinted on the server, driven by the parameters from the subscription URL.
 */
class SubscriptionMonitorService {
    static states = new Map();
    static config = null;

    /**
     * Starts monitoring.
     * @param {Object} params - Service configuration.
     * @param {Function} params.getSubscriptions - Async function returning monitored subscriptions.
     * @param {Function} params.getCookie - Async function returning the Vinted cookie of a domain.
     * @param {number} params.intervalMs - Base interval between checks of one subscription.
     * @param {Function} params.onItem - Called as onItem(item, subscription) for every new item.
     * @returns {Promise<void>}
     */
    static async start({ getSubscriptions, getCookie, intervalMs, onItem }) {
        this.config = { getSubscriptions, getCookie, intervalMs, onItem };
        await this.refresh();
    }

    /**
     * Stops all timers.
     */
    static stop() {
        for (const state of this.states.values()) {
            clearTimeout(state.timer);
        }
        this.states.clear();
    }

    /**
     * Synchronizes timers with the current list of monitored subscriptions.
     * Called on start and whenever the list of subscriptions changes.
     * @returns {Promise<void>}
     */
    static async refresh() {
        if (!this.config) {
            return;
        }

        let subscriptions;
        try {
            subscriptions = await this.config.getSubscriptions();
        } catch (error) {
            Logger.error(`Failed to load monitored subscriptions: ${error.message}`);
            return;
        }

        const seen = new Set();
        let added = 0;

        for (const subscription of subscriptions) {
            const key = subscription.subscriptionId;
            seen.add(key);

            const existing = this.states.get(key);
            if (!existing) {
                this.states.set(key, {
                    subscription,
                    // The position survives a restart, so a restart neither resends known
                    // items nor silently swallows the ones that appeared while it was down.
                    lastSeenId: Number(subscription.lastSeenItemId) || 0,
                    backoffMultiplier: 1,
                    timer: null,
                });
                this.scheduleNext(key, added * STAGGER_STEP_MS);
                added += 1;
                continue;
            }

            // A changed URL means a different search, so the last seen ID is forgotten.
            if (existing.subscription.url !== subscription.url) {
                existing.lastSeenId = 0;
            }
            existing.subscription = subscription;
        }

        for (const [key, state] of this.states) {
            if (!seen.has(key)) {
                clearTimeout(state.timer);
                this.states.delete(key);
            }
        }

        Logger.info(`Monitoring ${this.states.size} Vinted subscription(s)`);
    }

    /**
     * Schedules the next check of one subscription.
     * @param {string} key - Subscription identifier.
     * @param {number} [delayMs] - Delay before the check; defaults to the interval.
     */
    static scheduleNext(key, delayMs) {
        const state = this.states.get(key);
        if (!state) {
            return;
        }

        const delay = delayMs ?? this.config.intervalMs * state.backoffMultiplier;
        state.timer = setTimeout(() => this.checkSubscription(key), delay);
    }

    /**
     * Checks one subscription for new items.
     * @param {string} key - Subscription identifier.
     * @returns {Promise<void>}
     */
    static async checkSubscription(key) {
        const state = this.states.get(key);
        if (!state) {
            return;
        }

        try {
            await this.collectNewItems(state);
            state.backoffMultiplier = 1;
        } catch (error) {
            if (error.code === HTTP_RATE_LIMIT) {
                state.backoffMultiplier = Math.min(state.backoffMultiplier * RATE_LIMIT_BACKOFF_FACTOR, MAX_BACKOFF_MULTIPLIER);
                Logger.warn(`Rate limited on subscription ${key}, next check in ${this.config.intervalMs * state.backoffMultiplier / 1000}s`);
            } else {
                Logger.error(`Error checking subscription ${key}: ${error.message}`);
            }
        }

        // Rescheduled even after an error, otherwise one failure would stop it for good.
        this.scheduleNext(key);
    }

    /**
     * Fetches the search results and reports items newer than the last seen one.
     * @param {Object} state - Subscription state.
     * @returns {Promise<void>}
     */
    static async collectNewItems(state) {
        const { subscription } = state;
        const filters = buildApiFiltersFromUrl(subscription.url);

        if (!hasAnyFilter(filters)) {
            Logger.warn(`Subscription ${subscription.subscriptionId} has no usable filters in its URL, skipping`);
            return;
        }

        // Each subscription is queried on the marketplace of its own URL, with the cookie
        // that belongs to it - the token of one marketplace is rejected by the others.
        const domain = getDomainFromUrl(subscription.url);
        const cookie = await this.config.getCookie(domain);

        const response = await fetchCatalogItems({
            cookie,
            filters,
            per_page: ITEMS_PER_REQUEST,
            domain,
        });

        if (!response.success) {
            const error = new Error(response.error || "Error fetching catalog items.");
            error.code = response.code;
            throw error;
        }

        const rawItems = response.items || [];
        if (!rawItems.length) {
            return;
        }

        const highestId = Math.max(...rawItems.map(item => Number(item.id)));

        // The first run only records the current state, otherwise a fresh subscription
        // would fire a burst of items the user has already scrolled past on the website.
        if (state.lastSeenId === 0) {
            state.lastSeenId = highestId;
            await crud.setSubscriptionLastSeenItemId(subscription.subscriptionId, highestId);
            Logger.info(`Subscription ${subscription.subscriptionId} synchronized at item ${highestId}`);
            return;
        }

        const newItems = rawItems
            .filter(item => Number(item.id) > state.lastSeenId)
            .sort((a, b) => Number(a.id) - Number(b.id));

        state.lastSeenId = highestId;
        await crud.setSubscriptionLastSeenItemId(subscription.subscriptionId, highestId);

        if (!newItems.length) {
            return;
        }

        // A full page of new items means more items appeared between two checks than fit
        // into a single request, and the oldest of them will never be seen.
        if (newItems.length === rawItems.length) {
            Logger.warn(`Subscription ${subscription.subscriptionId} returned a full page of new items, some may have been missed. Shorten the interval or narrow the search.`);
        }

        await this.reportItems(newItems, subscription, cookie);
    }

    /**
     * Adds details to new items, applies local filters and hands them over.
     * @param {Array<Object>} rawItems - Raw items from the catalog response.
     * @param {Object} subscription - Subscription the items belong to.
     * @param {string} cookie - Cookie of the marketplace the items came from.
     * @returns {Promise<void>}
     */
    static async reportItems(rawItems, subscription, cookie) {
        const concurrency = Math.max(1, Number(ConfigurationManager.getAlgorithmSetting.concurrent_requests) || 1);
        const filterZeroStars = ConfigurationManager.getAlgorithmSetting.filter_zero_stars_profiles;
        let reported = 0;

        for (let i = 0; i < rawItems.length; i += concurrency) {
            const batch = rawItems.slice(i, i + concurrency);

            const items = await Promise.all(batch.map(async raw => {
                const item = new VintedItem(raw);
                const detail = await fetchItemDetail({ cookie, url: item.url });
                return item.mergeDetail(detail);
            }));

            for (const item of items) {
                if (filterZeroStars && item.getNumericStars() === 0) {
                    continue;
                }

                // Only what the server cannot do is left: banned keywords and fuzzy text match.
                const [matched] = filterItemsByUrl([item], subscription.url, subscription.bannedKeywords || []);
                if (!matched) {
                    continue;
                }

                await this.config.onItem(item, subscription);
                reported += 1;
            }
        }

        if (reported > 0) {
            await crud.incrementSubscriptionItemsFound(subscription.subscriptionId, reported);
        }
    }
}

export default SubscriptionMonitorService;
