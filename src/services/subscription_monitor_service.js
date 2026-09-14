import Logger from "../utils/logger.js";
import { fetchCatalogItems } from "../api/fetchCatalogItems.js";
import { VintedItem } from "../entities/vinted_item.js";
import { buildApiFiltersFromUrl, hasAnyFilter, containsBannedKeyword, getDomainFromUrl } from "./url_service.js";
import crud from "../crud.js";

// After a failed check the pause of that subscription doubles, and the first successful check
// resets it. A marketplace that blocks or breaks is then asked less and less often instead of
// at the normal pace; the ceiling keeps one bad hour from pausing a subscription for a day.
const BACKOFF_FACTOR = 2;
const MAX_BACKOFF_DELAY_MS = 30 * 60 * 1000;
// Vinted refusing the requests - a rate limit or its bot protection - rather than a bot error.
const REFUSED_STATUS_CODES = [403, 429];
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
    static refreshChain = Promise.resolve();
    // False until the subscriptions have been loaded once since the start.
    static initialized = false;

    /**
     * Starts monitoring.
     * @param {Object} params - Service configuration.
     * @param {Function} params.getSubscriptions - Async function returning monitored subscriptions.
     * @param {Function} params.getCookie - Async function returning the Vinted cookie of a domain.
     * @param {number} params.intervalMinMs - Shortest pause between two checks of one subscription.
     * @param {number} [params.intervalMaxMs] - Longest pause; every pause is picked at random in between.
     * @param {Function} params.onItem - Called as onItem(item, subscription) for every new item.
     * @returns {Promise<void>}
     */
    static async start({ getSubscriptions, getCookie, intervalMinMs, intervalMaxMs, onItem }) {
        this.config = {
            getSubscriptions,
            getCookie,
            intervalMinMs,
            intervalMaxMs: Math.max(intervalMaxMs ?? intervalMinMs, intervalMinMs),
            onItem,
        };
        this.initialized = false;
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
        this.initialized = false;
    }

    /**
     * Synchronizes timers with the current list of monitored subscriptions.
     * Called on start and whenever the list of subscriptions changes.
     *
     * Calls are queued: two overlapping runs could finish out of order, and the older
     * database read would then bring back a subscription that was just deleted.
     * @returns {Promise<void>}
     */
    static refresh() {
        const run = this.refreshChain.then(() => this.synchronize());
        this.refreshChain = run.catch(() => {});
        return run;
    }

    /**
     * One synchronization run, see refresh().
     * @returns {Promise<void>}
     */
    static async synchronize() {
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
                    // Right after the bot starts every subscription begins from scratch: its first
                    // check only records the current results, so nothing published while the bot
                    // was down is sent. A subscription resumed later keeps its stored position.
                    lastSeenId: this.initialized ? Number(subscription.lastSeenItemId) || 0 : 0,
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

        if (!this.initialized) {
            Logger.info('Items published while the bot was down are skipped, the first check of each subscription only records its current results');
        }
        this.initialized = true;

        Logger.info(`Monitoring ${this.states.size} Vinted subscription(s)`);
    }

    /**
     * Whether a running check still belongs to a monitored subscription.
     * A deleted or paused subscription loses its state on refresh, and a resumed one gets a
     * new state object - in both cases a check that was already running has to stop.
     * @param {Object} state - State the check was started with.
     * @returns {boolean} - True while the state is the live one.
     */
    static isCurrent(state) {
        return this.states.get(state.subscription.subscriptionId) === state;
    }

    /**
     * Pause before the next check: a random point between the shortest and the longest
     * interval, so the checks do not fall into a fixed rhythm, multiplied after failures.
     * @param {Object} state - Subscription state.
     * @returns {number} - Delay in milliseconds.
     */
    static nextDelay(state) {
        const { intervalMinMs, intervalMaxMs } = this.config;
        const interval = intervalMinMs + Math.random() * (intervalMaxMs - intervalMinMs);
        return Math.round(Math.min(interval * state.backoffMultiplier, MAX_BACKOFF_DELAY_MS));
    }

    /**
     * Schedules the next check of one subscription.
     * @param {string} key - Subscription identifier.
     * @param {number} [delayMs] - Delay before the check; defaults to nextDelay().
     */
    static scheduleNext(key, delayMs) {
        const state = this.states.get(key);
        if (!state) {
            return;
        }

        const delay = delayMs ?? this.nextDelay(state);
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

        let failure = null;
        try {
            await this.collectNewItems(state);
            state.backoffMultiplier = 1;
        } catch (error) {
            failure = error;
            // Past the ceiling the delay is capped anyway, so the multiplier stops growing there.
            if (this.config.intervalMinMs * state.backoffMultiplier < MAX_BACKOFF_DELAY_MS) {
                state.backoffMultiplier *= BACKOFF_FACTOR;
            }
        }

        // A subscription deleted or paused during this check is not rescheduled, and a resumed
        // one already runs on its own timer - scheduling it here as well would start a second
        // loop and every item would arrive twice.
        if (!this.isCurrent(state)) {
            if (failure) {
                Logger.error(`Error checking subscription ${key}: ${failure.message}`);
            }
            return;
        }

        // Rescheduled even after an error, otherwise one failure would stop it for good.
        const delay = this.nextDelay(state);

        if (failure) {
            const next = `next check in ${Math.round(delay / 1000)}s`;
            if (REFUSED_STATUS_CODES.includes(failure.code)) {
                Logger.warn(`Vinted refused subscription ${key} (${next}): ${failure.message}`);
            } else {
                Logger.error(`Error checking subscription ${key} (${next}): ${failure.message}`);
            }
        }

        this.scheduleNext(key, delay);
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
        // that belongs to it.
        const domain = getDomainFromUrl(subscription.url);
        const cookie = await this.config.getCookie(domain);

        // The catalog page is fetched with the parameters of the saved URL itself, so every
        // filter the website supports keeps working without a translation table.
        const response = await fetchCatalogItems({
            cookie,
            url: subscription.url,
            domain,
        });

        if (!response.success) {
            const error = new Error(response.error || "Error fetching catalog items.");
            error.code = response.code;
            throw error;
        }

        // The request takes a moment; the subscription may be gone by the time it returns.
        if (!this.isCurrent(state)) {
            return;
        }

        const rawItems = response.items || [];
        if (!rawItems.length) {
            return;
        }

        const highestId = Math.max(...rawItems.map(item => Number(item.id)));

        // The first check only records the current state: for a fresh subscription, and for
        // every subscription right after the bot starts. Otherwise a burst of items the user has
        // already scrolled past, or that piled up while the bot was down, would be sent.
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
        // into a single page, and the oldest of them will never be seen.
        if (newItems.length === rawItems.length) {
            Logger.warn(`Subscription ${subscription.subscriptionId} returned a full page of new items, some may have been missed. Shorten the interval or narrow the search.`);
        }

        await this.reportItems(newItems, state);
    }

    /**
     * Hands the new items over, skipping the ones with a banned keyword.
     *
     * Everything comes from the catalog page; no item page is downloaded. Whatever else the
     * search asks for has already been applied by Vinted when it rendered that page.
     * @param {Array<Object>} rawItems - Items from the catalog page, oldest first.
     * @param {Object} state - State of the subscription the items belong to.
     * @returns {Promise<void>}
     */
    static async reportItems(rawItems, state) {
        const { subscription } = state;
        let reported = 0;
        let handled = 0;

        for (const raw of rawItems) {
            // Delivery takes about a second per message, so a large batch can outlive its
            // subscription. Once it is deleted or paused, nothing more is sent.
            if (!this.isCurrent(state)) {
                Logger.info(`Subscription ${subscription.subscriptionId} was deleted or paused, dropped ${rawItems.length - handled} pending item(s)`);
                break;
            }

            handled += 1;
            const item = new VintedItem(raw);

            if (containsBannedKeyword(item, subscription.bannedKeywords)) {
                continue;
            }

            await this.config.onItem(item, subscription);
            reported += 1;
        }

        if (reported > 0) {
            await crud.incrementSubscriptionItemsFound(subscription.subscriptionId, reported);
        }
    }
}

export default SubscriptionMonitorService;
