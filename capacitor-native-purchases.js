/* CAS-971: vendored verbatim from node_modules/@capgo/native-purchases/dist/plugin.js (v8.9.10) - StoreKit 2.
   Loading this after capacitor-core.js registers Capacitor.Plugins.NativePurchases as a side effect. */
var capacitorNativePurchases = (function (exports, core) {
    'use strict';

    exports.ATTRIBUTION_NETWORK = void 0;
    (function (ATTRIBUTION_NETWORK) {
        ATTRIBUTION_NETWORK[ATTRIBUTION_NETWORK["APPLE_SEARCH_ADS"] = 0] = "APPLE_SEARCH_ADS";
        ATTRIBUTION_NETWORK[ATTRIBUTION_NETWORK["ADJUST"] = 1] = "ADJUST";
        ATTRIBUTION_NETWORK[ATTRIBUTION_NETWORK["APPSFLYER"] = 2] = "APPSFLYER";
        ATTRIBUTION_NETWORK[ATTRIBUTION_NETWORK["BRANCH"] = 3] = "BRANCH";
        ATTRIBUTION_NETWORK[ATTRIBUTION_NETWORK["TENJIN"] = 4] = "TENJIN";
        ATTRIBUTION_NETWORK[ATTRIBUTION_NETWORK["FACEBOOK"] = 5] = "FACEBOOK";
    })(exports.ATTRIBUTION_NETWORK || (exports.ATTRIBUTION_NETWORK = {}));
    exports.PURCHASE_TYPE = void 0;
    (function (PURCHASE_TYPE) {
        /**
         * A type of SKU for in-app products.
         */
        PURCHASE_TYPE["INAPP"] = "inapp";
        /**
         * A type of SKU for subscriptions.
         */
        PURCHASE_TYPE["SUBS"] = "subs";
    })(exports.PURCHASE_TYPE || (exports.PURCHASE_TYPE = {}));
    /**
     * Enum for billing features.
     * Currently, these are only relevant for Google Play Android users:
     * https://developer.android.com/reference/com/android/billingclient/api/BillingClient.FeatureType
     */
    exports.BILLING_FEATURE = void 0;
    (function (BILLING_FEATURE) {
        /**
         * Purchase/query for subscriptions.
         */
        BILLING_FEATURE[BILLING_FEATURE["SUBSCRIPTIONS"] = 0] = "SUBSCRIPTIONS";
        /**
         * Subscriptions update/replace.
         */
        BILLING_FEATURE[BILLING_FEATURE["SUBSCRIPTIONS_UPDATE"] = 1] = "SUBSCRIPTIONS_UPDATE";
        /**
         * Purchase/query for in-app items on VR.
         */
        BILLING_FEATURE[BILLING_FEATURE["IN_APP_ITEMS_ON_VR"] = 2] = "IN_APP_ITEMS_ON_VR";
        /**
         * Purchase/query for subscriptions on VR.
         */
        BILLING_FEATURE[BILLING_FEATURE["SUBSCRIPTIONS_ON_VR"] = 3] = "SUBSCRIPTIONS_ON_VR";
        /**
         * Launch a price change confirmation flow.
         */
        BILLING_FEATURE[BILLING_FEATURE["PRICE_CHANGE_CONFIRMATION"] = 4] = "PRICE_CHANGE_CONFIRMATION";
    })(exports.BILLING_FEATURE || (exports.BILLING_FEATURE = {}));
    exports.PRORATION_MODE = void 0;
    (function (PRORATION_MODE) {
        PRORATION_MODE[PRORATION_MODE["UNKNOWN_SUBSCRIPTION_UPGRADE_DOWNGRADE_POLICY"] = 0] = "UNKNOWN_SUBSCRIPTION_UPGRADE_DOWNGRADE_POLICY";
        /**
         * Replacement takes effect immediately, and the remaining time will be
         * prorated and credited to the user. This is the current default behavior.
         */
        PRORATION_MODE[PRORATION_MODE["IMMEDIATE_WITH_TIME_PRORATION"] = 1] = "IMMEDIATE_WITH_TIME_PRORATION";
        /**
         * Replacement takes effect immediately, and the billing cycle remains the
         * same. The price for the remaining period will be charged. This option is
         * only available for subscription upgrade.
         */
        PRORATION_MODE[PRORATION_MODE["IMMEDIATE_AND_CHARGE_PRORATED_PRICE"] = 2] = "IMMEDIATE_AND_CHARGE_PRORATED_PRICE";
        /**
         * Replacement takes effect immediately, and the new price will be charged on
         * next recurrence time. The billing cycle stays the same.
         */
        PRORATION_MODE[PRORATION_MODE["IMMEDIATE_WITHOUT_PRORATION"] = 3] = "IMMEDIATE_WITHOUT_PRORATION";
        /**
         * Replacement takes effect when the old plan expires, and the new price will
         * be charged at the same time.
         */
        PRORATION_MODE[PRORATION_MODE["DEFERRED"] = 4] = "DEFERRED";
    })(exports.PRORATION_MODE || (exports.PRORATION_MODE = {}));
    exports.PACKAGE_TYPE = void 0;
    (function (PACKAGE_TYPE) {
        /**
         * A package that was defined with a custom identifier.
         */
        PACKAGE_TYPE["UNKNOWN"] = "UNKNOWN";
        /**
         * A package that was defined with a custom identifier.
         */
        PACKAGE_TYPE["CUSTOM"] = "CUSTOM";
        /**
         * A package configured with the predefined lifetime identifier.
         */
        PACKAGE_TYPE["LIFETIME"] = "LIFETIME";
        /**
         * A package configured with the predefined annual identifier.
         */
        PACKAGE_TYPE["ANNUAL"] = "ANNUAL";
        /**
         * A package configured with the predefined six month identifier.
         */
        PACKAGE_TYPE["SIX_MONTH"] = "SIX_MONTH";
        /**
         * A package configured with the predefined three month identifier.
         */
        PACKAGE_TYPE["THREE_MONTH"] = "THREE_MONTH";
        /**
         * A package configured with the predefined two month identifier.
         */
        PACKAGE_TYPE["TWO_MONTH"] = "TWO_MONTH";
        /**
         * A package configured with the predefined monthly identifier.
         */
        PACKAGE_TYPE["MONTHLY"] = "MONTHLY";
        /**
         * A package configured with the predefined weekly identifier.
         */
        PACKAGE_TYPE["WEEKLY"] = "WEEKLY";
    })(exports.PACKAGE_TYPE || (exports.PACKAGE_TYPE = {}));
    exports.INTRO_ELIGIBILITY_STATUS = void 0;
    (function (INTRO_ELIGIBILITY_STATUS) {
        /**
         * doesn't have enough information to determine eligibility.
         */
        INTRO_ELIGIBILITY_STATUS[INTRO_ELIGIBILITY_STATUS["INTRO_ELIGIBILITY_STATUS_UNKNOWN"] = 0] = "INTRO_ELIGIBILITY_STATUS_UNKNOWN";
        /**
         * The user is not eligible for a free trial or intro pricing for this product.
         */
        INTRO_ELIGIBILITY_STATUS[INTRO_ELIGIBILITY_STATUS["INTRO_ELIGIBILITY_STATUS_INELIGIBLE"] = 1] = "INTRO_ELIGIBILITY_STATUS_INELIGIBLE";
        /**
         * The user is eligible for a free trial or intro pricing for this product.
         */
        INTRO_ELIGIBILITY_STATUS[INTRO_ELIGIBILITY_STATUS["INTRO_ELIGIBILITY_STATUS_ELIGIBLE"] = 2] = "INTRO_ELIGIBILITY_STATUS_ELIGIBLE";
    })(exports.INTRO_ELIGIBILITY_STATUS || (exports.INTRO_ELIGIBILITY_STATUS = {}));

    const NativePurchases = core.registerPlugin('NativePurchases', {
        web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.NativePurchasesWeb()),
    });

    class NativePurchasesWeb extends core.WebPlugin {
        async configure(options) {
        }
        async getUnfinishedTransactions(options) {
            console.error('getUnfinishedTransactions only mocked in web');
            return { transactions: [] };
        }
        async finishTransaction(options) {
            console.error('finishTransaction only mocked in web');
        }
        async restorePurchases() {
            console.error('restorePurchases only mocked in web');
        }
        async getProducts(options) {
            console.error('getProducts only mocked in web ' + options);
            return { products: [] };
        }
        async getProduct(options) {
            console.error('getProduct only mocked in web ' + options);
            return { product: {} };
        }
        async purchaseProduct(options) {
            console.error('purchaseProduct only mocked in web' + options);
            return { transactionId: 'transactionId' };
        }
        async isBillingSupported() {
            console.error('isBillingSupported only mocked in web');
            return { isBillingSupported: false };
        }
        async getPluginVersion() {
            console.warn('Cannot get plugin version in web');
            return { version: 'default' };
        }
        async getPurchases(options) {
            console.error('getPurchases only mocked in web ' + options);
            return { purchases: [] };
        }
        async manageSubscriptions() {
            console.error('manageSubscriptions only mocked in web');
        }
        async presentOfferCodeRedeemSheet() {
            console.error('presentOfferCodeRedeemSheet only mocked in web');
        }
        async acknowledgePurchase(options) {
            console.error('acknowledgePurchase only mocked in web');
        }
        async consumePurchase(options) {
            throw new Error('consumePurchase is only available on Android');
        }
        async getStorefront() {
            console.error('getStorefront only mocked in web');
            return { countryCode: '' };
        }
        async getAppTransaction() {
            console.error('getAppTransaction only mocked in web');
            return {
                appTransaction: {
                    originalAppVersion: '1.0.0',
                    originalPurchaseDate: new Date().toISOString(),
                    bundleId: 'com.example.app',
                    appVersion: '1.0.0',
                    environment: null,
                },
            };
        }
        async isEntitledToOldBusinessModel(options) {
            console.error('isEntitledToOldBusinessModel only mocked in web');
            return {
                isOlderVersion: false,
                originalAppVersion: '1.0.0',
            };
        }
    }

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        NativePurchasesWeb: NativePurchasesWeb
    });

    exports.NativePurchases = NativePurchases;

    return exports;

})({}, capacitorExports);
