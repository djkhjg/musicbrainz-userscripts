// ==UserScript==
// @name         Harmony: More Provider Lookups
// @namespace    https://github.com/djkhjg/musicbrainz-userscripts
// @version      0.32.25
// @description  Adds provider lookups, release comparisons, and MusicBrainz release action metadata to Harmony.
// @author       djkhjg
// @license      MIT
// @homepageURL  https://github.com/djkhjg/musicbrainz-userscripts
// @supportURL   https://github.com/djkhjg/musicbrainz-userscripts/issues
// @noframes
// @grant        unsafeWindow
// @grant        GM_listValues
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @match        https://harmony.pulsewidth.org.uk/*
// @match        https://harmony.mybrainz.dev/*
// @match        https://bandcamp.com/*
// @match        https://*.bandcamp.com/*
// @match        https://www.traxsource.com/*
// @match        https://traxsource.com/*
// @match        https://music.youtube.com/*
// @match        https://soundcloud.com/*
// @match        https://*.7digital.com/*
// @match        https://www.zdigital.com.au/*
// @connect      musicbrainz.org
// @connect      bandcamp.com
// @connect      traxsource.com
// @connect      youtube.com
// @connect      soundcloud.com
// @connect      zdigital.com.au
// @connect      7digital.com
// @connect      raw.githubusercontent.com

// ==/UserScript==
// 1.0.0: Github release.


(() => {
    'use strict';

    // Set false to disable all MPL activity for a provider; reload open pages.
    // Native Harmony providers retain their original controls and functionality.
    const ENABLED_PROVIDERS = {
        bandcamp: true,
        traxsource: true,
        ytmusic: true,
        soundcloud: true,
        sevendigital: true,
    };

    // Comparison settings: percentages use 0–100; tolerances use the stated units.
    const TITLE_MATCH_THRESHOLD_PERCENT = 78;
    const DISTRIBUTOR_MAP_URL = 'https://raw.githubusercontent.com/djkhjg/music-distributor-to-platform-map/main/distributor-platforms.json';
    const DISTRIBUTOR_MAP_REFRESH_MS = 24 * 60 * 60 * 1000;
    const DISTRIBUTOR_MAP_RETRY_MS = 60 * 60 * 1000;
    const DATE_COMPARISON_TOLERANCE_DAYS = 7;
    // These words alone do not establish a highlighted matching phrase.
    const COMPARISON_EXCLUDED_WORDS = new Set(['a','an','the','i','of','and','or','to','in','on','for','with','ep','lp','single']);

    const TRACK_LENGTH_TOLERANCE_SECONDS = 5;       // Beyond this difference: red and blocked.
    const TRACK_LENGTH_GREEN_TOLERANCE_SECONDS = 1; // Within this: green; otherwise orange up to the maximum.

    // MPL provider IDs, in display and execution order. Native always runs first.
    // Unlisted providers remain enabled and follow their batch in alphabetical order.
    const NATIVE_PROVIDER_ORDER = ['bandcamp'];
    const NON_NATIVE_PROVIDER_ORDER = ['soundcloud', 'traxsource', 'ytmusic', 'sevendigital'];


    // Capture before provider page scripts can silence or replace console methods.
    // Explicit inspection commands also return their contents, so console filters
    // or methods replaced before userscript startup cannot hide the data itself.
    const mplConsole = Object.fromEntries(
        ['info', 'warn', 'log', 'error', 'table', 'dir', 'group', 'groupCollapsed', 'groupEnd']
            .map(method => [method, typeof console[method] === 'function'
                ? console[method].bind(console) : () => {}])
    );

    // =========================================================================
    // SHARED UTILITIES AND PROVIDER REGISTRY
    // =========================================================================

    // Set true to enable all MPL diagnostics in both Harmony and helper tabs.
    const DEBUG = false;
    // Total max number of saved cache entries, recommended to be divisible by CACHE_BLOCK_SIZE.
    //  Default: 2000
    const CACHE_MAX_ENTRIES = 2000;
    // Number of cache entries per block. Once cache exceeds CACHE_MAX_ENTRIES, the oldest block will be deleted
    //  Default: 200
    const CACHE_BLOCK_SIZE = 200;
    // Number of cache blocks reserved for level 2 cache entries.
    // Level 1 cache entries are partial data, usually retrieved from search results, and exist to be navigation starting points
    // Level 2 cache entries are richer data, usually retrieved directly from release pages
    // During lookup, the comparision panel checks all lv2 cache first before checking lv1.
    // If a lv1 entry is found, then navigation occurs to upgrade it to lv2 before displaying in the comparison panel
    //  Default: 2
    const CACHE_LEVEL2_BLOCKS = 2;
    const DEBUG_STARTED_AT = Date.now();

    function debugInfo(...args) {
        if (DEBUG) mplConsole.info('[+' + (Date.now() - DEBUG_STARTED_AT) + 'ms]', ...args);
    }

    function debugWarn(...args) {
        if (DEBUG) mplConsole.warn('[+' + (Date.now() - DEBUG_STARTED_AT) + 'ms]', ...args);
    }

    function debugTrace(event, request = null, details = {}) {
        if (!DEBUG) return;
        debugInfo('[Harmony: More Provider Lookups]', event, {
            timestamp: new Date().toISOString(),
            ...(request ? {
                requestId: request.id,
                provider: request.provider,
                state: request.state,
                phase: request.phase,
                requestElapsedMs: Date.now() - request.startedAt
            } : {}),
            ...details
        });
    }

    const PROVIDER_PANEL_ID = 'hmpl-provider-panel';
    const RESOLVER_REQUEST_KEY_PREFIX = 'hmpl-resolver-request-v1-';
    const PROVIDER_DEFAULT_KEY_PREFIX = 'hmpl-provider-default-';
    const PROVIDER_SELECTIONS_KEY = 'hmpl-provider-selections-v1';
    const MPL_FLOW_STATUS_KEY = 'harmony-provider-flow:mpl';

    // =========================================================================
    // Provider registry
    // =========================================================================

    /*
     * Provider-specific modules register themselves here.
     *
     * The generic Harmony/core code below should not need to know which
     * providers exist or how their websites work.
     */

    const PROVIDERS = {};

    function isProviderEnabled(provider) {
        return ENABLED_PROVIDERS[provider.id] !== false;
    }

    function removeDisabledProviderControls() {
        for (const provider of Object.values(PROVIDERS)) {
            if (isProviderEnabled(provider) || provider.harmony?.native !== false) continue;
            for (const id of [provider.id+'-input', 'hmpl-lookup-'+provider.id+'-input', 'hmpl-settings-'+provider.id+'-input']) {
                const input=document.getElementById(id);
                if (input) (input.closest('.provider-input') || input).remove();
            }
        }
    }

    function orderedProviders(providers=Object.values(PROVIDERS)) {
        const rank=provider=>{
            const native=provider.harmony?.native!==false,list=native?NATIVE_PROVIDER_ORDER:NON_NATIVE_PROVIDER_ORDER;
            const index=list.indexOf(provider.id);
            return [native?0:1,index<0?list.length:index];
        };
        return [...providers].filter(isProviderEnabled).sort((a,b)=>{const x=rank(a),y=rank(b);return x[0]-y[0]||x[1]-y[1]||a.id.localeCompare(b.id);});
    }

    // Reorder MPL-owned provider positions without moving Harmony's other controls,
    // changing checkbox state, or replacing nodes/listeners from other scripts.
    function orderHarmonyProviderElements() {
        const providers=orderedProviders(),rank=new Map(providers.map((p,i)=>[p.id,i]));
        const identify=node=>{
            const control=node.querySelector('input');
            const id=control?.dataset.hmplProvider||node.dataset.mplProvider||node.dataset.provider||control?.id?.replace(/^hmpl-(?:lookup|settings)-/,'').replace(/-input$/,'');
            return providers.find(p=>p.id===id||p.name===id)||providers.find(p=>p.matchesReleaseUrl?.(node.querySelector('a.provider-id')?.href||''));
        };
        for(const selector of ['.provider-input','.provider-list > li','figure.cover-image']){
            const parents=new Map();
            for(const node of document.querySelectorAll(selector)){
                const provider=identify(node);if(!provider)continue;
                if(!parents.has(node.parentNode))parents.set(node.parentNode,[]);
                parents.get(node.parentNode).push({node,provider});
            }
            for(const items of parents.values()){
                const sorted=[...items].sort((a,b)=>rank.get(a.provider.id)-rank.get(b.provider.id));
                if(items.every((item,i)=>item===sorted[i]))continue;
                const markers=items.map(({node})=>{const marker=document.createComment('MPL provider order');node.replaceWith(marker);return marker;});
                markers.forEach((marker,i)=>marker.replaceWith(sorted[i].node));
            }
        }
    }

    // =========================================================================
    // General helpers
    // =========================================================================

    const $ = (selector, root = document) =>
        root.querySelector(selector);

    const $$ = (selector, root = document) => [
        ...root.querySelectorAll(selector)
    ];

    const clean = value =>
        String(value ?? '')
            .replace(/\s+/g, ' ')
            .trim();

    const isHarmony = () =>
        [
            'harmony.pulsewidth.org.uk',
            'harmony.mybrainz.dev'
        ].includes(location.hostname);


    // =========================================================================
    // Shared normalization and comparison utilities
    // =========================================================================

    function requestId() {
        return (
            crypto.randomUUID?.() ||
            `${Date.now()}-${Math.random()
                .toString(36)
                .slice(2)}`
        );
    }

    function stripReleaseTypeSuffix(value) {
        return String(value ?? '')
            .replace(
                /\s*(?:[-–—]\s*)?(?:\(|\[)?(?:ep|lp|single)(?:\)|\])?\s*$/i,
                ''
            )
            .trim();
    }

    function normalizeTitle(value) {
        return String(value ?? '').replace(/(?<![\p{L}\p{N}])(?:ep|lp|single)(?![\p{L}\p{N}])/giu,' ')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[’‘]/g, "'")
            .replace(/&/g, ' and ')
            .replace(/[^\p{L}\p{N}']+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeComparisonText(value) {
        return String(value ?? '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[’‘]/g, "'")
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeComparisonGtin(value) {
        return String(value ?? '')
            .replace(/\D/g, '')
            .replace(/^0+/, '');
    }

    function normalizeDate(value) {
        const text = clean(value);

        if (!text) {
            return '';
        }

        /*
         * Already ISO-ish:
         *
         * 2018
         * 2018-01
         * 2018-01-12
         */
        if (
            /^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(text)
        ) {
            return text;
        }

        const date = new Date(text);

        if (
            Number.isNaN(
                date.getTime()
            )
        ) {
            return text;
        }

        const year =
            date.getUTCFullYear();

        const month =
            String(
                date.getUTCMonth() + 1
            ).padStart(
                2,
                '0'
            );

        const day =
            String(
                date.getUTCDate()
            ).padStart(
                2,
                '0'
            );

        return `${year}-${month}-${day}`;
    }

    function gtinsMatch(a, b) {
        const left =
            normalizeComparisonGtin(a);

        const right =
            normalizeComparisonGtin(b);

        return Boolean(
            left &&
            right &&
            left === right
        );
    }

    function levenshteinDistance(a, b) {
        const rows =
            b.length + 1;

        const columns =
            a.length + 1;

        const matrix =
            Array.from(
                {
                    length: rows
                },
                () =>
                    new Array(columns)
            );

        for (
            let i = 0;
            i < rows;
            i++
        ) {
            matrix[i][0] = i;
        }

        for (
            let j = 0;
            j < columns;
            j++
        ) {
            matrix[0][j] = j;
        }

        for (
            let i = 1;
            i < rows;
            i++
        ) {
            for (
                let j = 1;
                j < columns;
                j++
            ) {
                const cost =
                    b[i - 1] ===
                    a[j - 1]
                        ? 0
                        : 1;

                matrix[i][j] =
                    Math.min(
                        matrix[i - 1][j] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j - 1] + cost
                    );
            }
        }

        return matrix[
            rows - 1
        ][
            columns - 1
        ];
    }

    function titleSimilarity(a, b) {
        const left =
            normalizeTitle(a);

        const right =
            normalizeTitle(b);

        if (
            !left ||
            !right
        ) {
            return 0;
        }

        if (
            left === right
        ) {
            return 1;
        }

        const maxLength =
            Math.max(
                left.length,
                right.length
            );

        const editSimilarity =
            1 -
            (
                levenshteinDistance(
                    left,
                    right
                ) /
                maxLength
            );

        const leftWords =
            new Set(
                left.split(' ')
            );

        const rightWords =
            new Set(
                right.split(' ')
            );

        const intersection =
            [
                ...leftWords
            ]
                .filter(
                    word =>
                        rightWords.has(word)
                )
                .length;

        const union =
            new Set(
                [
                    ...leftWords,
                    ...rightWords
                ]
            ).size;

        const wordSimilarity =
            union
                ? intersection / union
                : 0;

        return (
            wordSimilarity * 0.6 +
            editSimilarity * 0.4
        );
    }

    function valuesMatch(
        type,
        wanted,
        current
    ) {
        if (
            current == null ||
            current === ''
        ) {
            return false;
        }

        switch (type) {
            case 'artist': {
                const keys=value=>String(value??'').split(',').map(normalizeCandidateArtist).filter(Boolean);
                const left=keys(wanted),right=keys(current);
                return left.length>0&&left.length===right.length&&left.every((key,index)=>key===right[index]);
            }
            case 'isrc':
                return clean(wanted).replace(/[^a-z0-9]/gi,'').toUpperCase()===clean(current).replace(/[^a-z0-9]/gi,'').toUpperCase();
            case 'gtin':
                return (
                    normalizeComparisonGtin(
                        wanted
                    ) ===
                    normalizeComparisonGtin(
                        current
                    )
                );

            case 'tracks':
                return (
                    Number(wanted) ===
                    Number(current)
                );

            case 'title':
                return (
                    normalizeTitle(
                        wanted
                    ) ===
                    normalizeTitle(
                        current
                    )
                );

            case 'date':
                return (
                    normalizeDate(
                        wanted
                    ) ===
                    normalizeDate(
                        current
                    )
                );

            default:
                return (
                    normalizeComparisonText(
                        wanted
                    ) ===
                    normalizeComparisonText(
                        current
                    )
                );
        }
    }

    // =========================================================================
    // HARMONY ADAPTER — selections, page context and response consumption
    // =========================================================================

    const MPL_MESSAGE_ID = 'hmpl-harmony-message';
    const MPL_SKIPPED_PROVIDERS_KEY = 'hmpl-skipped-providers-v1';

    // =========================================================================
    // Harmony: cooperating-userscript handshake
    // =========================================================================

    function setMplFlowStatus(status) {
        if (!isHarmony()) {
            return;
        }

        sessionStorage.setItem(
            MPL_FLOW_STATUS_KEY,
            status
        );
        document.documentElement.setAttribute('data-harmony-provider-flow-mpl',status);
        document.dispatchEvent(new Event('harmony:mpl-flow'));

        document.querySelectorAll('[data-hmpl-retry]').forEach(button=>{button.disabled=status!=='finished';});

        debugInfo(
            '[Harmony: More Provider Lookups]',
            `MPL flow status: ${status}`
        );
    }

    function getMplFlowStatus() {
        if (!isHarmony()) {
            return null;
        }

        return sessionStorage.getItem(
            MPL_FLOW_STATUS_KEY
        );
    }

    function consumeMplReturnLoad() {
        if (!isHarmony()) {
            return false;
        }

        // Busy also describes pending panels and background requests. Only an
        // explicit destination-matched native batch marks a return navigation.
        if (!harmonyContinuation()) {
            return false;
        }

        setMplFlowStatus(
            harmonyContinuation()?.providers.length ? 'busy' : 'finished'
        );

        debugInfo(
            '[Harmony: More Provider Lookups]',
            'MPL return load detected; external provider lookup suppressed for this page load.'
        );

        return true;
    }

    // =========================================================================
    // Harmony: settings defaults and tab selections
    // =========================================================================

    function isHarmonySettings() {
        return (
            isHarmony() &&
            location.pathname ===
            '/settings'
        );
    }

    function getProviderDefault(provider) {
        return (
            localStorage.getItem(
                `${PROVIDER_DEFAULT_KEY_PREFIX}${provider.id}`
            ) === '1'
        );
    }

    function setProviderDefault(
        provider,
        enabled
    ) {
        localStorage.setItem(
            `${PROVIDER_DEFAULT_KEY_PREFIX}${provider.id}`,
            enabled
                ? '1'
                : '0'
        );
    }

    function getProviderSelections() {
        try {
            const stored =
                sessionStorage.getItem(
                    PROVIDER_SELECTIONS_KEY
                );

            if (!stored) {
                return {};
            }

            const parsed =
                JSON.parse(stored);

            return (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
            )
                ? parsed
                : {};
        } catch (error) {
            debugWarn(
                '[Harmony: More Provider Lookups]',
                'Could not read MPL provider session selections.',
                error
            );

            return {};
        }
    }

    function saveProviderSelections(selections) {
        sessionStorage.setItem(
            PROVIDER_SELECTIONS_KEY,
            JSON.stringify(selections)
        );
    }

    function getProviderSelection(provider) {
        const selections =
            getProviderSelections();

        if (
            Object.prototype.hasOwnProperty.call(
                selections,
                provider.id
            )
        ) {
            return Boolean(
                selections[provider.id]
            );
        }

        /*
         * The settings checkbox is only a default for a new Harmony tab/session.
         * Once initialized, the lookup-page selection belongs to sessionStorage
         * and is independent of later settings changes.
         */
        const enabled =
            getProviderDefault(provider);

        selections[provider.id] =
            enabled;

        saveProviderSelections(
            selections
        );

        return enabled;
    }

    function setProviderSelection(
        provider,
        enabled
    ) {
        const selections =
            getProviderSelections();

        selections[provider.id] =
            Boolean(enabled);

        saveProviderSelections(
            selections
        );
    }

    function getMplProviderCheckbox(
        provider,
        mode
    ) {
        return $(
            `#hmpl-${mode}-${provider.id}-input`
        );
    }

    function replaceHarmonyProviderCheckbox(
        provider,
        mode
    ) {
        const existing =
            getMplProviderCheckbox(
                provider,
                mode
            );

        if (existing) {
            return existing;
        }

        const nativeCheckbox =
            $(
                `#${provider.id}-input`
            );

        if (!nativeCheckbox) {
            if(provider.harmony?.native!==false)return null;
            const existingControl=document.querySelector('.provider-input');
            if(!existingControl)return null;
            const label=injectionElement('label','provider-input '+provider.id);
            if(provider.presentation?.backgroundColor)label.style.backgroundColor=provider.presentation.backgroundColor;
            const control=injectionElement('input');control.type='checkbox';control.id=provider.id+'-input';
            label.htmlFor=control.id;label.append(injectionProviderIcon(provider,'','control'),provider.name,control);
            if(provider.presentation?.controlForeground){
                label.style.color=provider.presentation.controlForeground;
                label.querySelectorAll('svg path').forEach(path=>path.setAttribute('fill',provider.presentation.controlForeground));
            }
            existingControl.parentElement.append(label);
            return replaceHarmonyProviderCheckbox(provider,mode);
        }

        /*
         * Clone only the visual/form-control attributes, not Harmony's event
         * listeners. The replacement deliberately has no name, so selecting an
         * MPL provider can never submit a provider parameter to Harmony.
         */
        const checkbox =
            nativeCheckbox.cloneNode(
                false
            );

        checkbox.id =
            `hmpl-${mode}-${provider.id}-input`;

        checkbox.removeAttribute(
            'name'
        );

        checkbox.removeAttribute(
            'value'
        );

        checkbox.disabled =
            false;

        checkbox.dataset.hmplProvider =
            provider.id;

        checkbox.dataset.hmplMode =
            mode;

        if (
            mode ===
            'settings'
        ) {
            checkbox.checked =
                getProviderDefault(
                    provider
                );
        } else {
            checkbox.checked =
                getProviderSelection(
                    provider
                );
        }

        const label =
            nativeCheckbox.closest(
                '.provider-input'
            );

        const oldId =
            nativeCheckbox.id;

        nativeCheckbox.replaceWith(
            checkbox
        );

        if (label) {
            if (
                label.getAttribute(
                    'for'
                ) === oldId
            ) {
                label.setAttribute(
                    'for',
                    checkbox.id
                );
            }

            label.title =
                mode === 'settings'
                    ? `${provider.name} default managed by Harmony: More Provider Lookups`
                    : `${provider.name} session selection managed by Harmony: More Provider Lookups`;
        }

        checkbox.addEventListener(
            'change',
            () => {
                if (
                    mode ===
                    'settings'
                ) {
                    setProviderDefault(
                        provider,
                        checkbox.checked
                    );

                    debugInfo(
                        '[Harmony: More Provider Lookups]',
                        `${provider.name} default ${
                            checkbox.checked
                                ? 'enabled'
                                : 'disabled'
                        }.`
                    );

                    return;
                }

                setProviderSelection(
                    provider,
                    checkbox.checked
                );

                debugInfo(
                    '[Harmony: More Provider Lookups]',
                    `${provider.name} session selection ${
                        checkbox.checked
                            ? 'enabled'
                            : 'disabled'
                    }.`
                );
            }
        );

        return checkbox;
    }

    function setupProviderDefaultSetting(provider) {
        return Boolean(
            replaceHarmonyProviderCheckbox(
                provider,
                'settings'
            )
        );
    }

    function initializeHarmonySettings() {
        removeDisabledProviderControls();
        for (
            const provider
            of orderedProviders()
        ) {
            setupProviderDefaultSetting(
                provider
            );
        }
        orderHarmonyProviderElements();
    }

    // =========================================================================
    // Harmony: release context extraction
    // =========================================================================

    function getHarmonyGtin() {
        for (
            const row
            of $$(
                'table.release-info tr'
            )
        ) {
            const heading =
                clean(
                    row.querySelector('th')
                        ?.textContent
                ).toUpperCase();

            if (
                heading !==
                'GTIN'
            ) {
                continue;
            }

            const value =
                clean(
                    row.querySelector('td')
                        ?.childNodes?.[0]
                        ?.textContent
                );

            if (
                !value ||
                value === '[unknown]'
            ) {
                return '';
            }

            return value.replace(
                /\D/g,
                ''
            );
        }

        return '';
    }

    function getHarmonyTrackCount() {
        let count = 0;

        for (
            const table
            of $$(
                'table.tracklist'
            )
        ) {
            count +=
                $$(
                    'tr',
                    table
                )
                    .filter(
                        row =>
                            row.querySelector(
                                'td'
                            )
                    )
                    .length;
        }

        return count;
    }

    function getHarmonyReleaseDate() {
        for (
            const row
            of $$(
                'table.release-info tr'
            )
        ) {
            const heading =
                clean(
                    row.querySelector('th')
                        ?.textContent
                );

            if (
                heading !==
                'Release date'
            ) {
                continue;
            }

            const value =
                clean(
                    row.querySelector('td')
                        ?.childNodes?.[0]
                        ?.textContent
                );

            if (
                !value ||
                value === '[unknown]'
            ) {
                return '';
            }

            return normalizeDate(
                value
            );
        }

        return '';
    }

    function harmonyDistributorCell(create=false){
        const rows=[...document.querySelectorAll('table.release-info tr')];
        let row=rows.find(row=>clean(row.querySelector('th')?.textContent)==='Distributor');
        if(!row && create){const labels=rows.find(row=>clean(row.querySelector('th')?.textContent)==='Labels');if(!labels)return null;
            row=document.createElement('tr');const th=document.createElement('th');th.textContent='Distributor';row.append(th,document.createElement('td'));labels.after(row);}
        return row?.querySelector('td')||null;
    }
    function separateHarmonyDistributor(){
        const row=[...document.querySelectorAll('table.release-info tr')].find(row=>clean(row.querySelector('th')?.textContent)==='Labels');
        const cell=row?.querySelector('td');if(!cell)return;
        const alternatives=[...cell.querySelectorAll(':scope > ul.alt-values > li')];
        for(const item of alternatives){
            const tidal=item.querySelector('.tidal');if(!tidal)continue;
            const names=[...item.querySelectorAll('.release-labels .entity-links')].map(node=>clean(node.textContent)).filter(Boolean);
            if(!names.length)continue;
            const destination=harmonyDistributorCell(true);
            const otherProviders=[...item.querySelectorAll('svg use')].some(use=>{const ref=use.getAttribute('href')||use.getAttribute('xlink:href')||'';return ref.includes('brand-')&&!ref.endsWith('brand-tidal');});
            const copy=item.cloneNode(true);
            copy.querySelectorAll('span[title]').forEach(badge=>{if(!badge.classList.contains('tidal'))badge.remove();});
            let list=destination.querySelector('ul');if(!list){list=document.createElement('ul');list.className='alt-values';destination.append(list);}
            if(![...list.children].some(child=>clean(child.textContent)===clean(copy.textContent)))list.append(copy);
            if(otherProviders)tidal.closest('a')?.remove()||tidal.remove();else item.remove();
            // Remove a selected label only when no non-Tidal source corroborates it.
            for(const name of names){
                const corroborated=[...cell.querySelectorAll(':scope > ul.alt-values .entity-links')].some(node=>clean(node.textContent)===name);
                if(corroborated)continue;
                for(const primary of cell.querySelectorAll(':scope > ul.release-labels > li')){
                    if(clean(primary.querySelector('.entity-links')?.textContent)!==name)continue;
                    if(primary.querySelector('svg use'))continue; // Native explicit attribution wins over inference.
                    primary.remove();
                    for(const form of document.querySelectorAll('form[name="release-seeder"]')){
                        for(const input of [...form.elements])if(/^labels\.\d+\.name$/.test(input.name)&&clean(input.value)===name){
                            const prefix=input.name.slice(0,-4);for(const field of [...form.elements])if(field.name.startsWith(prefix))field.remove();
                        }
                    }
                }
            }
        }
    }
    function getHarmonyDistributor(){
        return [...new Set([...(harmonyDistributorCell()?.querySelectorAll('.entity-links')||[])].map(node=>clean(node.textContent)).filter(Boolean))];
    }

    function getHarmonyLabel() {
        for (
            const row
            of $$(
                'table.release-info tr'
            )
        ) {
            const heading =
                clean(
                    row.querySelector('th')
                        ?.textContent
                );

            if (
                heading !==
                'Labels'
            ) {
                continue;
            }

            /*
             * Harmony renders the merged/current label list first.
             * Alternative values are rendered afterward.
             */
            const labelList =
                row.querySelector(
                    'td > ul.release-labels'
                );

            if (!labelList) {
                return '';
            }

            const labels =
                $$(
                    ':scope > li',
                    labelList
                )
                    .map(
                        item => {
                            const entity =
                                item.querySelector(
                                    '.entity-links'
                                );

                            if (!entity) {
                                return clean(
                                    item.textContent
                                );
                            }

                            const clone =
                                entity.cloneNode(
                                    true
                                );

                            /*
                             * Remove provider-icon-only links while preserving
                             * the actual displayed label name, including
                             * "[no label]".
                             */
                            for (
                                const link
                                of clone.querySelectorAll(
                                    'a'
                                )
                            ) {
                                if (
                                    !clean(
                                        link.textContent
                                    )
                                ) {
                                    link.remove();
                                }
                            }

                            return clean(
                                clone.textContent
                            );
                        }
                    )
                    .filter(Boolean);

            return labels.join(
                ', '
            );
        }

        return '';
    }

    function getHarmonyCoverArt() {
        const cover =
            $('figure.cover-image');

        if (!cover) {
            return '';
        }

        const link =
            cover.querySelector(
                'a[href]'
            );

        if (link?.href) {
            return clean(
                link.href
            );
        }

        const image =
            cover.querySelector(
                'img[src]'
            );

        return clean(
            image?.currentSrc ||
            image?.src
        );
    }

    function getHarmonyReleaseContext() {
        const title =
            clean(
                $('.release-title')
                    ?.textContent
            );

        const credit=document.querySelector('.release-artist .artist-credit');
        const artists=credit?injectionArtistsFromNode(credit).map(artist=>artist.name).filter(Boolean):[];

        if (
            !title ||
            !artists.length
        ) {
            return null;
        }

        return {
            title,
            artists,

            gtin:
                getHarmonyLookupGtin(),

            distributor:getHarmonyDistributor(),
            tracks: getHarmonyComparisonTracks(),
            trackCount:
                getHarmonyTrackCount(),

            date:
                getHarmonyReleaseDate(),

            label:
                getHarmonyLabel(),

            coverArt:
                getHarmonyCoverArt()
        };
    }

    // =========================================================================
    // Harmony: lookup form and provider controls
    // =========================================================================

    function getHarmonyLookupUrls() {
        if (!isHarmony()) {
            return [];
        }

        return new URL(
            location.href
        )
            .searchParams
            .getAll('url')
            .map(clean)
            .filter(Boolean);
    }

    function getVisibleLookupUrls() {
        const form =
            $('#url-input')
                ?.closest('form');

        if (!form) {
            return [];
        }

        return $$(
            'input[name="url"]',
            form
        )
            .map(
                input =>
                    clean(
                        input.value
                    )
            )
            .filter(Boolean);
    }

    function hasProviderUrl(provider) {
        return getVisibleLookupUrls()
            .some(
                url =>
                    provider.matchesReleaseUrl?.(
                        url
                    )
            );
    }

    function addLookupUrl(
        value = ''
    ) {
        const form =
            $('#url-input')
                ?.closest('form');

        if (!form) {
            return null;
        }

        const template =
            form._hmplUrlTemplate;

        const urlStack =
            form._hmplUrlStack;

        if (
            !template ||
            !urlStack
        ) {
            return null;
        }

        const row =
            document.createElement(
                'div'
            );

        row.className =
            'hmpl-url-row hmpl-extra-url-row';

        const field =
            template.cloneNode(
                true
            );

        const input =
            $(
                'input[name="url"]',
                field
            );

        if (!input) {
            return null;
        }

        input.id =
            `hmpl-url-input-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2)}`;

        input.value =
            value;

        const removeButton =
            document.createElement(
                'button'
            );

        removeButton.type =
            'button';

        removeButton.className =
            'hmpl-url-button hmpl-remove-url';

        removeButton.textContent =
            '×';

        removeButton.title =
            'Remove URL';

        removeButton.addEventListener(
            'click',
            () => {
                row.remove();
            }
        );

        row.append(
            field,
            removeButton
        );

        urlStack.append(
            row
        );

        return input;
    }

    function setupMultiUrlControls() {
        const urlInput =
            $('#url-input');

        const form =
            urlInput
                ?.closest('form');

        if (
            !urlInput ||
            !form
        ) {
            return false;
        }

        if (
            form.dataset
                .hmplMultiUrlReady ===
            '1'
        ) {
            return true;
        }

        const fieldWrapper =
            urlInput.parentElement;

        if (!fieldWrapper) {
            return false;
        }

        form._hmplUrlTemplate =
            fieldWrapper.cloneNode(
                true
            );

        const urlStack =
            document.createElement(
                'div'
            );

        urlStack.className =
            'hmpl-url-stack';

        const primaryRow =
            document.createElement(
                'div'
            );

        primaryRow.className =
            'hmpl-url-row hmpl-primary-url-row';

        fieldWrapper.replaceWith(
            urlStack
        );

        primaryRow.append(
            fieldWrapper
        );

        urlStack.append(
            primaryRow
        );

        form._hmplUrlStack =
            urlStack;

        form.dataset
            .hmplMultiUrlReady =
            '1';

        const addButton =
            document.createElement(
                'button'
            );

        addButton.type =
            'button';

        addButton.id =
            'hmpl-add-url';

        addButton.className =
            'hmpl-url-button';

        addButton.textContent =
            '+';

        addButton.title =
            'Add another provider URL';

        addButton.addEventListener(
            'click',
            () => {
                const input =
                    addLookupUrl();

                input?.focus();
            }
        );

        primaryRow.append(
            addButton
        );

        const urls =
            getHarmonyLookupUrls();

        if (urls.length) {
            urlInput.value =
                urls[0];

            for (
                const url
                of urls.slice(1)
            ) {
                addLookupUrl(
                    url
                );
            }
        }

        return true;
    }

    function injectMultiUrlStyles() {
        if (
            $('#hmpl-multi-url-styles')
        ) {
            return;
        }

        const style =
            document.createElement(
                'style'
            );

        style.id =
            'hmpl-multi-url-styles';

        style.textContent = `
            .hmpl-url-stack {
                display: flex;
                flex-direction: column;
                gap: 0.35rem;
                align-self: flex-start;
            }

            .hmpl-url-row {
                display: flex;
                align-items: stretch;
            }

            .hmpl-url-row > .input-overlay,
            .hmpl-url-row > label,
            .hmpl-url-row > div:first-child {
                flex: 1 1 auto;
            }

            .hmpl-url-button {
                margin-left: 0.3rem;
                min-width: 2rem;
                cursor: pointer;
                font-weight: bold;
            }

            .hmpl-remove-url {
                font-size: 1.15em;
            }
        `;

        (
            document.head ||
            document.documentElement
        ).append(
            style
        );
    }

    function setupLookupProviderControl(provider) {
        return Boolean(
            replaceHarmonyProviderCheckbox(
                provider,
                'lookup'
            )
        );
    }

    function captureProviderSelectionSnapshot() {
        const snapshot = {};

        for (
            const provider
            of orderedProviders()
        ) {
            const checkbox =
                getMplProviderCheckbox(
                    provider,
                    'lookup'
                );

            snapshot[provider.id] =
                checkbox
                    ? Boolean(
                        checkbox.checked
                    )
                    : getProviderSelection(
                        provider
                    );
        }

        return snapshot;
    }

    function getRequestedExternalProviders(
        selectionSnapshot
    ) {
        return orderedProviders()
            .filter(
                provider =>
                    Boolean(
                        selectionSnapshot
                            ?.[provider.id]
                    )
            );
    }

    function harmonyHasLookupResult() {
        return Boolean(
            $('.release:not([data-mpl-created])')
        );
    }

    function harmonyLookupFinishedWithoutRelease() {
        return $$('.message.error p')
            .some(
            element =>
            clean(element.textContent) ===
            'No provider returned a release'
        );
    }

    // =========================================================================
    // Harmony: resolver responses and status messages
    // =========================================================================

    function buildHarmonyReturnUrl(
        harmonyUrl,
        resultUrl = null
    ) {
        const url =
            new URL(
                harmonyUrl
            );

        if (resultUrl) {
            const existingUrls =
                url.searchParams.getAll(
                    'url'
                );

            if (
                !existingUrls.includes(
                    resultUrl
                )
            ) {
                url.searchParams.append(
                    'url',
                    resultUrl
                );
            }
        }

        return url.href;
    }

    function getSkippedProviders() {
        try {
            const stored =
                  sessionStorage.getItem(
                      MPL_SKIPPED_PROVIDERS_KEY
                  );

            if (!stored) {
                return [];
            }

            const parsed =
                  JSON.parse(stored);

            return Array.isArray(parsed)
                ? parsed
            : [];
        } catch {
            return [];
        }
    }

    function saveSkippedProviders(
    providers
    ) {
        sessionStorage.setItem(
            MPL_SKIPPED_PROVIDERS_KEY,
            JSON.stringify(providers)
        );
    }

    function addSkippedProvider(
    provider
    ) {
        const skipped =
              getSkippedProviders().sort((a,b)=>{const names=orderedProviders().map(p=>p.name);return names.indexOf(a)-names.indexOf(b);});

        if (
            !skipped.includes(
                provider.name
            )
        ) {
            skipped.push(
                provider.name
            );

            saveSkippedProviders(
                skipped
            );
        }

        return skipped;
    }

    async function retrySkippedProvider(provider) {
        if(getMplFlowStatus()!=='finished' || document.querySelector('#'+PROVIDER_PANEL_ID))return;
        const target=getHarmonyReleaseContext()||harmonyInputTarget();
        // Remove only this provider's previous outcome. The normal single-provider
        // flow handles cache lookup, review, injection and native URL submission.
        saveSkippedProviders(getSkippedProviders().filter(name=>name!==provider.name));
        setMplFlowStatus('busy');
        renderMplHarmonyMessage();
        try {
            await requestHarmonyProviderLookups([provider],target);
        } catch(error) {
            addSkippedProvider(provider);
            setMplFlowStatus('finished');
            debugWarn('Provider retry failed',provider.id,error);
            const message=injectionElement('div','message error');
            message.append(injectionElement('p','',provider.name+': '+error.message));
            document.querySelector('main')?.append(message);
        } finally {
            renderMplHarmonyMessage();
        }
    }

    function createHarmonySpriteIcon(
    name
    ) {
        const svg =
              document.createElementNS(
                  'http://www.w3.org/2000/svg',
                  'svg'
              );

        svg.classList.add(
            'icon'
        );

        svg.setAttribute(
            'width',
            '24'
        );

        svg.setAttribute(
            'height',
            '24'
        );

        svg.setAttribute(
            'stroke-width',
            '2'
        );

        const use =
              document.createElementNS(
                  'http://www.w3.org/2000/svg',
                  'use'
              );

        use.setAttributeNS(
            'http://www.w3.org/1999/xlink',
            'xlink:href',
            `/icon-sprite.svg#${name}`
        );

        svg.append(
            use
        );

        return svg;
    }

    function renderMplHarmonyMessage() {
        const release =
              $('.release');

        if (!release) {
            return false;
        }

        const skipped =
              getSkippedProviders();

        let message =
            $(
                `#${MPL_MESSAGE_ID}`,
                release
            );

        if (!skipped.length) {
            message?.remove();

            return true;
        }

        if (!message) {
            message =
                document.createElement(
                'div'
            );

            message.id =
                MPL_MESSAGE_ID;

            /*
         * These are Harmony's own MessageBox classes.
         * Its existing stylesheet supplies the native blue info styling.
         */
            message.className =
                'message info';

            const icon =
                  createHarmonySpriteIcon(
                      'info-circle'
                  );

            const providerLabel =
                  document.createElement(
                      'span'
                  );

            providerLabel.className =
                'provider';

            providerLabel.textContent =
                'More Provider Lookups:';

            const body =
                  document.createElement(
                      'div'
                  );

            body.className =
                'hmpl-message-body';

            message.append(
                icon,
                providerLabel,
                body
            );

            /*
         * Harmony renders its MessageBox elements immediately before
         * .release-title, so do the same.
         */
            const releaseTitle =
                  $('.release-title', release);

            if (releaseTitle) {
                release.insertBefore(
                    message,
                    releaseTitle
                );
            } else {
                release.prepend(
                    message
                );
            }
        }

        const body =
              $('.hmpl-message-body', message);

        if (!body) {
            return false;
        }

        body.replaceChildren();

        for (
            const providerName
            of skipped
        ) {
            const line =
                  document.createElement(
                      'p'
                  );

            line.textContent =
                `${providerName} skipped`;

            const provider=Object.values(PROVIDERS).find(item=>item.name===providerName);
            if(provider && isProviderEnabled(provider)){
                const retry=document.createElement('button');retry.type='button';retry.textContent='↺';
                retry.dataset.hmplRetry=provider.id;
                retry.title='Retry '+provider.name;
                retry.setAttribute('aria-label','Retry '+provider.name);
                retry.disabled=getMplFlowStatus()!=='finished';
                retry.style.cssText='margin-left:6px;padding:0 5px;cursor:pointer';
                retry.addEventListener('click',()=>retrySkippedProvider(provider));
                line.append(' ',retry);
            }
            body.append(line);
        }

        return true;
    }





    // =========================================================================
    // Harmony: page initialization
    // =========================================================================



    // =========================================================================
    // =========================================================================
    // INJECT TO HARMONY — normalize, prepare structure, merge UI and seed
    // =========================================================================
    // Markup follows Harmony Release/Tracklist/ReleaseLabels/AlternativeValues and
    // ReleaseSeeder components. Native primary values remain selected; conflicting
    // provider values are alternatives. This adapter never merges cache records.

    function injectionElement(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== '') node.textContent = text;
        return node;
    }

    function injectionUrl(value) {
        try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ''; }
        catch { return ''; }
    }

    function injectionArtists(values = []) {
        return values.map(value => typeof value === 'string' ? { name: clean(value) } : { ...value, name: clean(value?.name) })
            .filter(value => value.name);
    }

    function normalizeFullRelease(record) {
        const artists = injectionArtists(record.artists);
        const media = (record.media || (record.tracks ? [{ tracks: record.tracks }] : [])).map(medium => ({
            title: clean(medium.title), format: clean(medium.format || record.format || 'Digital Media'),
            tracks: (medium.tracks || medium.tracklist || []).map((track, index) => ({
                ...track, title: clean(track.title), number: clean(track.number ?? index + 1),
                artists: injectionArtists(track.artists?.length ? track.artists : artists),
                length: Number.isFinite(Number(track.lengthMs ?? track.durationMs ?? track.length)) &&
                    Number(track.lengthMs ?? track.durationMs ?? track.length) > 0 ? Math.round(Number(track.lengthMs ?? track.durationMs ?? track.length)) : null,
                isrc: clean(track.isrc).replace(/[^a-z0-9]/gi, '').toUpperCase(), url: injectionUrl(track.url)
            }))
        }));
        const labels = (record.labels || (record.label ? [typeof record.label === 'string' ? { name: record.label } : record.label] : []))
            .map(label => ({ ...label, name: clean(label.name), catalogNumber: clean(label.catalogNumber || record.catalogNumber) })).filter(label => label.name);
        return { ...record, title: clean(record.title), artists, media, labels, date: clean(record.date),
            gtin: clean(record.gtin), url: injectionUrl(record.url), coverArt: injectionUrl(record.coverArt) };
    }

    function fullReleaseIsComplete(record) {
        if (!record || record.tracklistComplete !== true) return false;
        const release = normalizeFullRelease(record);
        return Boolean(release.title && release.artists.length && release.media.length &&
            release.media.every(medium => medium.tracks.length && medium.tracks.every(track => track.title && track.artists.length)));
    }

    // Static provider artwork is constructed without HTML/XML parsing sinks.
    function createProviderSvg(shape) {
        const allowed=new Set(['svg','g','path','circle','ellipse','rect','line','polyline','polygon']);
        if(!allowed.has(shape.tag))throw new Error('Unsupported provider icon shape');
        const node=document.createElementNS('http://www.w3.org/2000/svg',shape.tag);
        for(const [name,value] of Object.entries(shape.attrs||{})){
            if(['viewBox','d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','transform','cx','cy','r','rx','ry','x','y','x1','x2','y1','y2','width','height','points'].includes(name)&&!/url\s*\(/i.test(value))node.setAttribute(name,value);
        }
        for(const child of shape.children||[])node.append(createProviderSvg(child));
        return node;
    }

    function injectionProviderIcon(provider, url = '', context = 'inline') {
        const badge = injectionElement('span', provider.id);
        badge.title = provider.name;
        badge.dataset.mplProviderIcon = provider.id;
        if (provider.presentation?.color) badge.style.color = provider.presentation.color;
        if (provider.presentation?.icon) {
            const svg=createProviderSvg(provider.presentation.icon);
            svg.setAttribute('class','icon');svg.setAttribute('width','18');svg.setAttribute('height','18');badge.append(svg);
        }
        if (!badge.childNodes.length) {
            const sprite = provider.presentation?.sprite || (provider.harmony?.native !== false ? 'brand-' + provider.id : 'world-www');
            const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
            for (const [name,value] of Object.entries({class:'icon',width:'18',height:'18','stroke-width':'1.5'})) svg.setAttribute(name,value);
            const use = document.createElementNS(svg.namespaceURI,'use');
            use.setAttributeNS('http://www.w3.org/1999/xlink','href','/icon-sprite.svg#'+sprite);
            svg.append(use);badge.append(svg);
        }
        const iconSize=(context==='control'?provider.presentation?.controlIconSize:null) || provider.presentation?.iconSize;
        if(iconSize){
            const svg=badge.querySelector('svg');
            if(svg){svg.setAttribute('width',iconSize);svg.setAttribute('height',iconSize);svg.style.width=iconSize+'px';svg.style.height=iconSize+'px';}
        }
        if (!injectionUrl(url)) return badge;
        // Provider icons use text colour, not the ordinary blue text-link colour.
        badge.style.color='inherit';
        const link = injectionElement('a','mpl-provider-icon-link');link.href=injectionUrl(url);link.append(badge);
        if(!document.getElementById('mpl-injection-icon-style')){
            const style=injectionElement('style');style.id='mpl-injection-icon-style';
            style.textContent='a.mpl-provider-icon-link:not(:hover):not(:focus-visible){color:inherit}';
            (document.head||document.documentElement).append(style);
        }
        return link;
    }

    function injectionPrimaryText(node) {
        if (!node) return '';
        const clone=node.cloneNode(true);
        clone.querySelectorAll('.alt-values,svg,button,[data-mpl-provider-icon],.he-overwritten-label').forEach(item=>item.remove());
        const text=clean(clone.textContent);
        return /^\[(?:unknown|none)\]$/i.test(text)?'':text;
    }

    function injectionComparable(value) {
        return clean(value).normalize('NFKC').toLowerCase();
    }

    function injectionArtistNode(artists) {
        const span=injectionElement('span','artist-credit');
        artists.forEach((artist,index)=>{
            const entity=injectionElement('span','entity-links');
            const url=injectionUrl(artist.url || (artist.mbid ? 'https://musicbrainz.org/artist/'+artist.mbid : ''));
            const name=clean(artist.creditedName || artist.name);
            if(url){const link=injectionElement('a','',name);link.href=url;entity.append(link);}else entity.append(name);
            span.append(entity);
            if(index<artists.length-1) span.append(artist.joinPhrase ?? (index===artists.length-2?' & ':', '));
        });
        return span;
    }

    function injectionLabelNode(label) {
        const span=injectionElement('span','entity-links');
        const url=injectionUrl(label.url || (label.mbid?'https://musicbrainz.org/label/'+label.mbid:''));
        if(url){const link=injectionElement('a','',label.name);link.href=url;span.append(link);}else span.append(label.name);
        const fragment=document.createDocumentFragment();fragment.append(span);
        if(label.catalogNumber) fragment.append(' '+label.catalogNumber);
        return fragment;
    }

    function injectionArtistsFromNode(node) {
        node=node.cloneNode(true);node.querySelectorAll('.alt-values').forEach(item=>item.remove());
        const entities=[...node.querySelectorAll('.entity-links')];
        if(!entities.length){const name=injectionPrimaryText(node);return name?[{name}]:[];}
        return entities.map(entity=>{
            const mbid=[...entity.querySelectorAll('a[href]')].map(link=>link.href.match(/musicbrainz\.org\/artist\/([0-9a-f-]{36})/i)?.[1]).find(Boolean);
            return {name:injectionPrimaryText(entity),...(mbid?{mbid}:{}),...(entity.nextSibling?.nodeType===3?{joinPhrase:entity.nextSibling.textContent}:{})};
        }).filter(artist=>artist.name);
    }

    function injectionArtistsFromSeed(form,prefix) {
        const indexes=[...new Set([...form.elements].map(input=>input.name.startsWith(prefix+'.names.')?Number(input.name.slice((prefix+'.names.').length).split('.')[0]):NaN).filter(Number.isInteger))].sort((a,b)=>a-b);
        return indexes.map(index=>({name:injectionSeedValue(form,`${prefix}.names.${index}.name`)||injectionSeedValue(form,`${prefix}.names.${index}.artist.name`),mbid:injectionSeedValue(form,`${prefix}.names.${index}.mbid`),joinPhrase:injectionSeedValue(form,`${prefix}.names.${index}.join_phrase`)})).filter(artist=>artist.name);
    }

    function createInjectionTrackTable(medium,index) {
        const table=injectionElement('table','tracklist');table.dataset.mplCreated='1';
        table.append(injectionElement('caption','',medium.title||medium.format+' '+(index+1)));
        const headings=table.createTHead().insertRow();
        ['Track','Title','Artists','Length','ISRC'].forEach(text=>headings.append(injectionElement('th','',text)));
        table.createTBody();return table;
    }

    function addInjectionAttribution(node, provider, url) {
        if ([...node.querySelectorAll('[data-mpl-provider-icon="'+provider.id+'"],span.'+provider.id+'[title]')].some(icon=>icon.closest('ul.alt-values')===node.closest('ul.alt-values'))) return;
        const entity=node.matches('.entity-links')?node:node.querySelector(':scope > .entity-links');
        if(entity) entity.prepend(injectionProviderIcon(provider,url));
        else node.insertBefore(injectionProviderIcon(provider,url),node.querySelector(':scope > ul.alt-values'));
    }

    function mergeDistributorEvidence(node,value,provider,url){
        if(!node||!value)return;
        let list=node.querySelector(':scope > ul.alt-values');
        if(!list){list=injectionElement('ul','alt-values');node.append(list);}
        let entry=[...list.children].find(item=>injectionComparable(injectionPrimaryText(item))===injectionComparable(value));
        if(!entry){entry=injectionElement('li');const span=injectionElement('span','alt-value');span.append(injectionElement('span','entity-links',value));entry.append(span);list.append(entry);}
        addInjectionAttribution(entry.querySelector('.alt-value')||entry,provider,url);
    }

    function mergeInjectionValue(node, value, provider, url, render = () => document.createTextNode(value), alternativesHost = node) {
        if(value==null || value==='') return false;
        const current=injectionPrimaryText(node);
        if(!current){
            const alternatives=[...node.children].filter(child=>child.classList.contains('alt-values'));
            node.replaceChildren(render(),...alternatives);
            addInjectionAttribution(node,provider,url);
            return true;
        }
        let list=alternativesHost.querySelector(':scope > ul.alt-values');
        const matching=list && [...list.children].find(item=>injectionComparable(injectionPrimaryText(item))===injectionComparable(value));
        if(matching){addInjectionAttribution(matching.querySelector('.alt-value')||matching,provider,url);return injectionComparable(current)===injectionComparable(value);}
        if(injectionComparable(current)===injectionComparable(value)) {addInjectionAttribution(node,provider,url);return true;}
        if(!list){list=injectionElement('ul','alt-values');alternativesHost.append(list);}
        let entry=[...list.children].find(item=>injectionComparable(injectionPrimaryText(item))===injectionComparable(value));
        if(!entry){entry=injectionElement('li');const span=injectionElement('span','alt-value');span.append(render());entry.append(span);list.append(entry);}
        addInjectionAttribution(entry.querySelector('.alt-value')||entry,provider,url);
        return false;
    }

    function mergeInjectionReleaseTitle(stage,value,provider,url) {
        if(!value)return;
        if(!injectionPrimaryText(stage.title))stage.title.textContent=value;
        // Harmony shows source spellings below the normalized heading.
        let list=null;
        for(let node=stage.title.nextElementSibling;node && node!==stage.artists;node=node.nextElementSibling){
            if(node.matches('ul.alt-values')){list=node;break;}
            if(node===stage.titleAlternatives)list=node.querySelector(':scope > ul.alt-values');
            if(list)break;
        }
        if(!list && injectionComparable(injectionPrimaryText(stage.title))===injectionComparable(value))return;
        if(!list){list=injectionElement('ul','alt-values');stage.titleAlternatives.append(list);}
        let entry=[...list.children].find(item=>injectionPrimaryText(item)===clean(value));
        if(!entry){entry=injectionElement('li');entry.append(injectionElement('span','alt-value',value));list.append(entry);}
        addInjectionAttribution(entry.querySelector('.alt-value')||entry,provider,url);
    }

    function mergeInjectionArtists(node,artists,provider) {
        const key=value=>injectionComparable(value).replace(/[\u2018\u2019]/g,"'").replace(/\s+/g,' ');
        const values=artists.map(artist=>({...artist,url:injectionUrl(provider.getArtistUrl?.(artist)||artist.url)}));
        const matches=credit=>{
            const existing=injectionArtistsFromNode(credit);
            return existing.length===values.length && existing.every((artist,index)=>key(artist.name)===key(values[index].creditedName||values[index].name));
        };
        let credit=node.matches('.artist-credit')?node:node.querySelector(':scope > .artist-credit');
        if(!injectionPrimaryText(node)){
            credit=injectionArtistNode(values);
            if(node.matches('.artist-credit')){node.replaceChildren(...credit.childNodes);credit=node;}else node.replaceChildren(credit);
        }else if(!credit || !matches(credit)){
            let list=node.querySelector(':scope > ul.alt-values');
            if(!list){list=injectionElement('ul','alt-values');node.append(list);}
            credit=[...list.querySelectorAll('.artist-credit')].find(matches);
            if(!credit){const item=injectionElement('li'),span=injectionElement('span','alt-value');credit=injectionArtistNode(values);span.append(credit);item.append(span);list.append(item);}
        }
        const entities=[...credit.querySelectorAll(':scope > .entity-links')];
        values.forEach((artist,index)=>{if(entities[index])addInjectionAttribution(entities[index],provider,artist.url);});
    }

    function injectionSeedValue(form, name) {
        return [...form.elements].find(input=>input.name===name)?.value || '';
    }

    function setInjectionSeed(form, name, value) {
        if(value==null || value==='') return;
        let input=[...form.elements].find(item=>item.name===name);
        // Native/current seed values remain authoritative; fill gaps only.
        if(input?.value) return;
        if(!input){input=injectionElement('input');input.type='hidden';input.name=name;input.dataset.mplSeed='1';form.append(input);}
        input.value=String(value);
    }

    function seedInjectionArtists(form,prefix,artists) {
        if([...form.elements].some(input=>input.name.startsWith(prefix+'.names.') && input.value)) return;
        artists.forEach((artist,index)=>{
            const base=prefix+'.names.'+index;
            setInjectionSeed(form,base+'.name',artist.creditedName||artist.name);
            if(artist.mbid) setInjectionSeed(form,base+'.mbid',artist.mbid);
            else setInjectionSeed(form,base+'.artist.name',artist.name);
            if(index<artists.length-1) setInjectionSeed(form,base+'.join_phrase',artist.joinPhrase ?? (index===artists.length-2?' & ':', '));
        });
    }

    function injectionDuration(length) {
        if(!length) return '';
        const seconds=Math.floor(length/1000)%60;
        const remainder=length%1000;
        return Math.floor(length/60000)+':'+String(seconds).padStart(2,'0')+(remainder?'.'+String(remainder).padStart(3,'0'):'');
    }

    function ensureHarmonyInjectionStructure(release) {
        const main=document.querySelector('main');
        if(!main) throw new Error('Harmony main element is not ready');
        let root=main.querySelector('.release');
        if(!root){root=injectionElement('div','release');root.dataset.mplCreated='1';main.append(root);}
        let title=root.querySelector('.release-title');
        if(!title){title=injectionElement('h2','release-title');root.prepend(title);}
        let titleAlternatives=root.querySelector('[data-mpl-title-alternatives]');
        if(!titleAlternatives){titleAlternatives=injectionElement('div');titleAlternatives.dataset.mplTitleAlternatives='1';title.after(titleAlternatives);}
        let artists=root.querySelector('.release-artist');
        if(!artists){artists=injectionElement('div','release-artist');titleAlternatives.after(artists);}
        let artistCredit=artists.querySelector('.artist-credit');
        if(!artistCredit){artistCredit=injectionElement('span','artist-credit');if(!clean(artists.textContent))artists.append('by ');artists.append(artistCredit);}
        let table=root.querySelector('table.release-info');
        if(!table){table=injectionElement('table','release-info');artists.after(table);}
        let tbody=table.tBodies[0];if(!tbody)tbody=table.createTBody();
        const cells={};
        for(const heading of ['Providers','Release date','Labels','GTIN','External links',...(release.copyright?['Copyright']:[]),...(release.types?.length?['Types']:[]),...Object.entries({status:'Status',packaging:'Packaging',language:'Language',script:'Script'}).filter(([key,heading])=>release[key] || document.querySelector('input[name="'+key+'"]') || [...table.rows].some(row=>clean(row.cells[0]?.textContent)===heading)).map(([,heading])=>heading)]){
            if(heading==='Labels' && !release.labels.length && !document.querySelector('input[name^="labels."]') && ![...table.rows].some(row=>clean(row.cells[0]?.textContent)==='Labels'))continue;
            let row=[...table.rows].find(item=>clean(item.cells[0]?.textContent)===heading);
            if(!row){row=injectionElement('tr');row.append(injectionElement('th','',heading),injectionElement('td'));tbody.append(row);}
            cells[heading]=row.cells[1];
        }
        let providerList=cells.Providers.querySelector('.provider-list');
        if(!providerList){providerList=injectionElement('ul','provider-list');cells.Providers.append(providerList);}
        let labels=cells.Labels?.querySelector(':scope > ul.release-labels');
        if(cells.Labels&&!labels){labels=injectionElement('ul','release-labels');cells.Labels.prepend(labels);}
        let links=cells['External links'].querySelector('ul');if(!links){links=injectionElement('ul');cells['External links'].append(links);}
        let forms=[...main.querySelectorAll('form[name="release-seeder"],form[name="release-update-seeder"]')];
        if(!forms.some(form=>form.getAttribute('name')==='release-seeder') && !forms.length){
            const row=injectionElement('div','row');const form=injectionElement('form');
            form.name='release-seeder';form.method='post';form.target='_blank';form.dataset.mplCreated='1';
            form.action='https://musicbrainz.org/release/add?skip_confirmation=1';
            const wrapper=injectionElement('div','input-with-overlay');const overlay=injectionElement('div','overlay');
            overlay.append(createHarmonySpriteIcon('database-import'));
            const submit=injectionElement('input');submit.type='submit';submit.value='Import into MusicBrainz';submit.disabled=true;
            wrapper.append(overlay,submit);form.append(wrapper);row.append(form);root.after(row);forms=[form];
        }
        // A surviving seed is the primary data source when its visible UI is missing.
        const primaryForm=forms.find(form=>form.getAttribute('name')==='release-seeder');
        if(primaryForm){
            if(!injectionPrimaryText(title))title.textContent=injectionSeedValue(primaryForm,'name');
            if(!injectionPrimaryText(artistCredit))artistCredit.append(injectionArtistNode(injectionArtistsFromSeed(primaryForm,'artist_credit')));
            if(!injectionPrimaryText(cells.GTIN))cells.GTIN.textContent=injectionSeedValue(primaryForm,'barcode');
            if(!injectionPrimaryText(cells['Release date']))cells['Release date'].textContent=['year','month','day'].map((part,index)=>{const value=injectionSeedValue(primaryForm,'events.0.date.'+part);return value&&index?value.padStart(2,'0'):value;}).filter(Boolean).join('-');
            if(labels&&!labels.children.length){
                for(const input of [...primaryForm.elements].filter(input=>/^labels\.\d+\.name$/.test(input.name))){
                    const prefix=input.name.slice(0,-5);const item=injectionElement('li');
                    item.append(injectionLabelNode({name:input.value,mbid:injectionSeedValue(primaryForm,prefix+'.mbid'),catalogNumber:injectionSeedValue(primaryForm,prefix+'.catalog_number')}));labels.append(item);
                }
            }
            const mediumIndexes=[...new Set([...primaryForm.elements].map(input=>/^mediums\.(\d+)\.track\./.exec(input.name)?.[1]).filter(value=>value!==undefined))].sort((a,b)=>Number(a)-Number(b));
            for(const value of mediumIndexes){
                const index=Number(value);
                if(root.querySelectorAll('table.tracklist')[index])continue;
                const medium={title:injectionSeedValue(primaryForm,`mediums.${index}.name`),format:injectionSeedValue(primaryForm,`mediums.${index}.format`)||'Digital Media'};
                const trackTable=createInjectionTrackTable(medium,index);
                const trackIndexes=[...new Set([...primaryForm.elements].map(input=>new RegExp('^mediums\\.'+index+'\\.track\\.(\\d+)\\.').exec(input.name)?.[1]).filter(item=>item!==undefined))].sort((a,b)=>Number(a)-Number(b));
                for(const trackIndex of trackIndexes){
                    const prefix=`mediums.${index}.track.${trackIndex}`;const row=trackTable.tBodies[0].insertRow();
                    row.append(injectionElement('td','numeric',injectionSeedValue(primaryForm,prefix+'.number')),injectionElement('td','',injectionSeedValue(primaryForm,prefix+'.name')));
                    const artistsCell=injectionElement('td');artistsCell.append(injectionArtistNode(injectionArtistsFromSeed(primaryForm,prefix+'.artist_credit')));row.append(artistsCell,injectionElement('td','numeric',injectionDuration(Number(injectionSeedValue(primaryForm,prefix+'.length')))),injectionElement('td'));
                }
                root.append(trackTable);
            }
        }
        const nativeTables=[...root.querySelectorAll('table.tracklist')];
        const media=release.media.map((medium,index)=>{
            let trackTable=nativeTables[index];
            if(!trackTable){
                trackTable=createInjectionTrackTable(medium,index);
                root.append(trackTable);
            }
            const body=trackTable.tBodies[0]||trackTable.createTBody();
            while(body.rows.length<medium.tracks.length){const row=body.insertRow();for(let i=0;i<Math.max(5,trackTable.tHead?.rows[0]?.cells.length||0);i++)row.append(injectionElement('td',i===0||i===3?'numeric':''));}
            // Existing tables may omit the ISRC column; every merged row needs
            // the same staging cells before attribution starts.
            for(const row of body.rows)while(row.cells.length<5)row.append(injectionElement('td'));
            if(trackTable.tHead?.rows[0]?.cells.length===4)trackTable.tHead.rows[0].append(injectionElement('th','','ISRC'));
            return {table:trackTable,rows:[...body.rows]};
        });
        return {root,title,titleAlternatives,artists,artistCredit,cells,providerList,labels,links,forms,media};
    }

    const injectionSeedRecords=new Map();
    let injectionSeedProtectionInstalled=false;
    function injectionEditNote(provider,release){
        const version='0.32.25';
        return '* '+provider.name+': '+(release.url||release.key||'(no URL)')+' (via Harmony: More Provider Lookups v'+version+')';
    }

    const injectionLinkTypes={'free streaming':85,'paid streaming':980,'paid download':74,'free download':75};
    function injectionSeedLinks(externalLinks){
        return externalLinks.flatMap(link=>{
            const url=injectionUrl(link.url);if(!url)return [];
            return (link.types?.length?link.types:[null]).map(type=>({url,typeId:String(injectionLinkTypes[type]??'')}));
        });
    }
    function seedInjectionProviderLinks(form,provider,release,externalLinks){
            for(const {url,typeId} of injectionSeedLinks(externalLinks)){
                const inputs=[...form.elements].filter(input=>/^urls\.\d+\.url$/.test(input.name));
                if(inputs.some(input=>input.value===url && injectionSeedValue(form,input.name.replace(/\.url$/,'.link_type'))===typeId))continue;
                const index=Math.max(-1,...inputs.map(input=>Number(input.name.split('.')[1])))+1;
                setInjectionSeed(form,'urls.'+index+'.url',url);setInjectionSeed(form,'urls.'+index+'.link_type',typeId);
            }
            const line=injectionEditNote(provider,release);
            let note=[...form.elements].find(input=>input.name==='edit_note');
            if(!note){setInjectionSeed(form,'edit_note',line);note=[...form.elements].find(input=>input.name==='edit_note');}
            else if(!note.value.split('\n').includes(line))note.value+='\n'+line;

    }
    function rememberInjectionSeed(provider,release,externalLinks){
        injectionSeedRecords.set(provider.id,{provider,release,externalLinks});
        if(injectionSeedProtectionInstalled)return;
        injectionSeedProtectionInstalled=true;
        const isSeed=form=>form?.matches?.('form[name="release-seeder"],form[name="release-update-seeder"]');
        document.addEventListener('submit',event=>{
            if(!isSeed(event.target))return;
            for(const record of injectionSeedRecords.values())seedInjectionProviderLinks(event.target,record.provider,record.release,record.externalLinks);
        },true);
        // FormData is the actual submitted payload, including replacement forms
        // or changes made by another submit handler after our capture listener.
        document.addEventListener('formdata',event=>{
            if(!isSeed(event.target))return;
            const data=event.formData;
            for(const {provider,release,externalLinks} of injectionSeedRecords.values()){
                for(const {url,typeId} of injectionSeedLinks(externalLinks)){
                    const entries=[...data.entries()].filter(([name])=>/^urls\.\d+\.url$/.test(name));
                    if(entries.some(([name,value])=>value===url && String(data.get(name.replace(/\.url$/,'.link_type'))??'')===typeId))continue;
                    const index=Math.max(-1,...[...data.keys()].map(name=>/^urls\.(\d+)\./.exec(name)?.[1]).filter(value=>value!==undefined).map(Number))+1;
                    data.append('urls.'+index+'.url',url);if(typeId)data.append('urls.'+index+'.link_type',typeId);
                }
                const line=injectionEditNote(provider,release);
                const note=String(data.get('edit_note')||'');if(!note.split('\n').includes(line))data.set('edit_note',note+(note?'\n':'')+line);
            }
            debugTrace('Injection: submitted provider URLs verified',null,{providers:[...injectionSeedRecords.keys()]});
        },true);
    }
    // Resolve selection once. The native seed is authoritative where populated;
    // surviving primary UI fills gaps, then the accepted provider fills gaps.
    // Alternatives are evidence for alignment, never independently seeded.
    function buildInjectionSelection(stage, incoming) {
        const form=stage.forms.find(item=>item.getAttribute('name')==='release-seeder');
        const seed=name=>form?injectionSeedValue(form,name):'';
        const entries=form?[...form.elements]:[];
        const text=heading=>injectionPrimaryText(stage.cells[heading]);
        const first=(...values)=>values.find(value=>value!==null && value!==undefined && value!=='' && (!Array.isArray(value)||value.length)) ?? '';
        const indexes=pattern=>[...new Set(entries.map(input=>pattern.exec(input.name)?.[1]).filter(value=>value!==undefined).map(Number))].sort((a,b)=>a-b);
        const date=['year','month','day'].map((part,i)=>{const value=seed('events.0.date.'+part);return value&&i?value.padStart(2,'0'):value;}).filter(Boolean).join('-');
        const selected={...incoming,title:first(seed('name'),injectionPrimaryText(stage.title),incoming.title),
            artists:first(form?injectionArtistsFromSeed(form,'artist_credit'):[],injectionArtistsFromNode(stage.artistCredit),incoming.artists),
            gtin:first(seed('barcode'),text('GTIN'),incoming.gtin),date:first(date,text('Release date'),incoming.date),
            copyright:first(text('Copyright'),incoming.copyright),
            types:first(indexes(/^type\.(\d+)$/).map(i=>seed('type.'+i)).filter(Boolean),text('Types')?text('Types').split(/\s*\+\s*/):[],incoming.types||[])||[],
            labels:[],media:[]};
        const scalarHeadings={status:'Status',packaging:'Packaging',language:'Language',script:'Script'};
        for(const [field,heading] of Object.entries(scalarHeadings)){
            const seeded=seed(field),visible=text(heading),provided=typeof incoming[field]==='string'?incoming[field]:'';
            // Language/script UI is a display label (often with a percentage),
            // whereas the seed uses a code. Never seed that display label.
            selected[field]=first(seeded,['language','script'].includes(field)?'':visible,provided);
            let display=selected[field];
            if(['language','script'].includes(field) && display){
                try{display=new Intl.DisplayNames(['en'],{type:field}).of(display)||display;}catch{}
                if(visible && (visible===display || visible.startsWith(display+' (')))display=visible;
            }
            selected[field+'Display']=display||visible;
        }
        const uiLabels=[...(stage.labels?.children||[])].map(item=>{
            const entity=item.querySelector('.entity-links');
            const name=injectionPrimaryText(entity)||injectionPrimaryText(item);
            const mbid=[...item.querySelectorAll('a[href]')].map(a=>a.href.match(/musicbrainz\.org\/label\/([\w-]+)/)?.[1]).find(Boolean);
            return {name,catalogNumber:injectionPrimaryText(item).slice(name.length).trim(),mbid};
        });
        const seedLabels=indexes(/^labels\.(\d+)\./);
        for(const index of seedLabels){
            const name=seed(`labels.${index}.name`),mbid=seed(`labels.${index}.mbid`);
            const ui=uiLabels.find(label=>name && injectionComparable(label.name)===injectionComparable(name))||(!name?uiLabels[index]:null)||{};
            selected.labels.push({name:first(name,ui.name),mbid:first(mbid,ui.mbid),catalogNumber:first(seed(`labels.${index}.catalog_number`),ui.catalogNumber),seedIndex:index});
        }
        for(const label of uiLabels){
            if(!selected.labels.some(item=>injectionComparable(item.name)===injectionComparable(label.name)))selected.labels.push({...label,seedIndex:Math.max(-1,...selected.labels.map(item=>item.seedIndex))+1});
        }
        for(const label of incoming.labels){
            const match=selected.labels.find(item=>injectionComparable(item.name)===injectionComparable(label.name));
            if(match){match.catalogNumber=first(match.catalogNumber,label.catalogNumber);match.mbid=first(match.mbid,label.mbid);}
            else selected.labels.push({...label,seedIndex:Math.max(-1,...selected.labels.map(item=>item.seedIndex))+1});
        }
        const tables=[...stage.root.querySelectorAll('table.tracklist')];
        const mediumIndexes=[...new Set([...indexes(/^mediums\.(\d+)\./),...tables.map((_,i)=>i),...incoming.media.map((_,i)=>i)])].sort((a,b)=>a-b);
        const duration=value=>{const m=clean(value).match(/^(\d+):(\d{2})(?:\.(\d{1,3}))?$/);return m?Number(m[1])*60000+Number(m[2])*1000+Number((m[3]||'').padEnd(3,'0')):null;};
        for(const index of mediumIndexes){
            const rows=tables[index]?[...tables[index].tBodies].flatMap(body=>[...body.rows]):[];
            const provided=incoming.media[index];
            const trackIndexes=indexes(new RegExp('^mediums\\.'+index+'\\.track\\.(\\d+)\\.'));
            const count=Math.max(trackIndexes.length?Math.max(...trackIndexes)+1:0,rows.length);
            const tracks=Array.from({length:count},(_,i)=>{
                const cells=rows[i]?.cells,prefix=`mediums.${index}.track.${i}`;
                return {number:first(seed(prefix+'.number'),injectionPrimaryText(cells?.[0]),String(i+1)),
                    title:first(seed(prefix+'.name'),injectionPrimaryText(cells?.[1])),
                    artists:first(form?injectionArtistsFromSeed(form,prefix+'.artist_credit'):[],cells?.[2]?injectionArtistsFromNode(cells[2]):[]),
                    length:Number(seed(prefix+'.length'))||duration(injectionPrimaryText(cells?.[3])),isrc:injectionPrimaryText(cells?.[4])};
            });
            const compatible=provided && (!tracks.length || tracks.length===provided.tracks.length);
            const chosen=tracks.length?tracks.map((track,i)=>{
                const source=compatible?provided.tracks[i]:{};
                return {...source,...track,title:first(track.title,source.title),artists:first(track.artists,source.artists,selected.artists),length:first(track.length,source.length)||null,isrc:first(track.isrc,source.isrc)};
            }):(provided?.tracks||[]);
            const caption=injectionPrimaryText(tables[index]?.caption);
            selected.media.push({seedIndex:index,title:first(seed(`mediums.${index}.name`),compatible?provided?.title:''),
                format:first(seed(`mediums.${index}.format`),['Digital Media','CD','Vinyl'].find(format=>caption.startsWith(format)),provided?.format,'Digital Media'),tracks:chosen});
        }
        return selected;
    }

    function renderInjectionSelection(stage, selected) {
        const primary=(node,value,render=()=>document.createTextNode(value))=>{
            if(!node || value==null || value==='')return;
            if(injectionPrimaryText(node)===clean(value))return;
            const alternatives=[...node.children].filter(child=>child.classList.contains('alt-values'));
            const old=injectionPrimaryText(node);
            if(old){
                let list=alternatives[0];if(!list){list=injectionElement('ul','alt-values');alternatives.push(list);}
                if(![...list.children].some(item=>injectionPrimaryText(item)===old)){
                    const item=injectionElement('li'),valueNode=injectionElement('span','alt-value');
                    for(const child of [...node.childNodes])if(!alternatives.includes(child))valueNode.append(child);
                    item.append(valueNode);list.append(item);
                }
            }
            node.replaceChildren(render(),...alternatives);
        };
        // Title alternatives belong below, never inside the heading.
        if(injectionPrimaryText(stage.title)!==selected.title){
            const old=injectionPrimaryText(stage.title);stage.title.textContent=selected.title;
            if(old){let list=stage.titleAlternatives.querySelector('ul.alt-values');if(!list){list=injectionElement('ul','alt-values');stage.titleAlternatives.append(list);}const li=injectionElement('li');li.append(injectionElement('span','alt-value',old));list.append(li);}
        }
        const credit=artists=>injectionArtistNode(artists);
        const artistText=artists=>clean(credit(artists).textContent);
        primary(stage.artistCredit,artistText(selected.artists),()=>{const node=credit(selected.artists),fragment=document.createDocumentFragment();fragment.append(...node.childNodes);return fragment;});
        for(const [heading,value] of Object.entries({'Release date':selected.date,GTIN:selected.gtin,Copyright:selected.copyright,Types:selected.types.join(' + '),Status:selected.statusDisplay,Packaging:selected.packagingDisplay,Language:selected.languageDisplay,Script:selected.scriptDisplay}))primary(stage.cells[heading],value);
        if(stage.labels){
            const existing=[...stage.labels.children],used=new Set();
            for(const label of selected.labels){
                let item=existing.find(node=>!used.has(node)&&injectionComparable(injectionPrimaryText(node.querySelector('.entity-links'))||injectionPrimaryText(node))===injectionComparable(label.name));
                if(!item){item=injectionElement('li');stage.labels.append(item);}used.add(item);
                primary(item,label.name+(label.catalogNumber?' '+label.catalogNumber:''),()=>injectionLabelNode(label));
            }
        }
        const tables=[...stage.root.querySelectorAll('table.tracklist')];
        selected.media.forEach((medium,index)=>{
            let table=tables[index];if(!table){table=createInjectionTrackTable(medium,index);stage.root.append(table);}
            const body=table.tBodies[0]||table.createTBody();
            medium.tracks.forEach((track,i)=>{
                const row=body.rows[i]||body.insertRow();while(row.cells.length<5)row.append(injectionElement('td'));
                primary(row.cells[0],track.number);primary(row.cells[1],track.title);
                primary(row.cells[2],artistText(track.artists),()=>credit(track.artists));
                primary(row.cells[3],injectionDuration(track.length));primary(row.cells[4],track.isrc);
            });
        });
    }

    function seedInjectionSelection(form, selected) {
        if(form.getAttribute('name')!=='release-seeder')return;
        // This serializer consumes only the resolved model, never provider input
        // or values independently re-derived from the rendered DOM.
        setInjectionSeed(form,'name',selected.title);seedInjectionArtists(form,'artist_credit',selected.artists);
        setInjectionSeed(form,'barcode',selected.gtin);
        if(/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(selected.date||''))selected.date.split('-').forEach((value,i)=>setInjectionSeed(form,'events.0.date.'+['year','month','day'][i],Number(value)));
        for(const label of selected.labels){const prefix='labels.'+label.seedIndex;setInjectionSeed(form,prefix+'.name',label.name);setInjectionSeed(form,prefix+'.catalog_number',label.catalogNumber);setInjectionSeed(form,prefix+'.mbid',label.mbid);}
        selected.media.forEach(medium=>{
            const prefix='mediums.'+medium.seedIndex;setInjectionSeed(form,prefix+'.format',medium.format);setInjectionSeed(form,prefix+'.name',medium.title);
            medium.tracks.forEach((track,i)=>{const p=prefix+'.track.'+i;setInjectionSeed(form,p+'.name',track.title);setInjectionSeed(form,p+'.number',track.number);seedInjectionArtists(form,p+'.artist_credit',track.artists);setInjectionSeed(form,p+'.length',track.length);});
        });
        for(const key of ['status','packaging','language','script'])setInjectionSeed(form,key,selected[key]);
        selected.types.forEach((type,i)=>setInjectionSeed(form,'type.'+i,type));
    }

    function injectFullReleaseResponse(response) {
        if(!isHarmony())throw new Error('Release injection is only available on Harmony');
        if(response.status!=='found' || !fullReleaseIsComplete(response.record))throw new Error('A found, complete full-release record is required');
        const provider=PROVIDERS[response.provider] || {id:response.provider,name:response.provider,harmony:{native:false}};
        if(!isProviderEnabled(provider))throw new Error('Provider disabled: '+provider.id);
        if(provider.prepareInjection)response={...response,record:provider.prepareInjection(response.record)};
        if(!/^[a-z][a-z0-9-]*$/i.test(provider.id))throw new Error('Invalid provider ID');
        const release=normalizeFullRelease({...response.record,provider:provider.id});
        const existing=[...document.querySelectorAll('main table.tracklist')];
        const counts=existing.map(table=>[...table.tBodies].reduce((sum,body)=>sum+body.rows.length,0));
        const tracks=release.media.flatMap(medium=>medium.tracks);
        if(counts.reduce((sum,n)=>sum+n,0)){
            if(counts.reduce((sum,n)=>sum+n,0)!==tracks.length)throw new Error('Track counts do not match; release cannot be merged.');
            let offset=0;
            release.media=counts.map((count,index)=>({...release.media[index],tracks:tracks.slice(offset,offset+=count)}));
        }
        const lengthReason=trackLengthAcceptanceReason({tracks:getHarmonyComparisonTracks()},release);
        if(lengthReason)throw new Error(lengthReason+' Release cannot be merged.');
        let stage=ensureHarmonyInjectionStructure(release);
        separateHarmonyDistributor();
        const selected=buildInjectionSelection(stage,release);
        renderInjectionSelection(stage,selected);
        for(const form of stage.forms)seedInjectionSelection(form,selected);
        stage=ensureHarmonyInjectionStructure(release);
        const sourceUrl=release.url;
        const externalLinks=[...(release.externalLinks||[])];
        if(sourceUrl&&!externalLinks.some(link=>link.url===sourceUrl))externalLinks.push({url:sourceUrl,types:provider.harmony?.linkTypes||[]});
        rememberInjectionSeed(provider,release,externalLinks);
        for(const form of stage.forms)seedInjectionProviderLinks(form,provider,release,externalLinks);
        if(!stage.providerList.querySelector(`[data-mpl-provider="${provider.id}"]`)){
            const item=injectionElement('li');item.dataset.mplProvider=provider.id;item.append(injectionProviderIcon(provider),provider.name+': ');
            const link=injectionElement('a','provider-id',provider.formatProviderLabel?.(release)||(clean(release.key)||sourceUrl||provider.name));if(sourceUrl)link.href=sourceUrl;
            item.append(link,injectionElement('span','label ml-2','via More Provider Lookups'));stage.providerList.append(item);
        }
        const distributor=release.distributor||release.firstTrackMetadata?.distributor;
        if(distributor)mergeDistributorEvidence(harmonyDistributorCell(true),distributor,provider,sourceUrl);
        mergeInjectionReleaseTitle(stage,release.title,provider,sourceUrl);
        mergeInjectionArtists(stage.artistCredit,release.artists,provider);
        mergeInjectionValue(stage.cells['Release date'],release.date,provider,sourceUrl);
        mergeInjectionValue(stage.cells.GTIN,release.gtin,provider,sourceUrl);
        if(release.copyright)mergeInjectionValue(stage.cells.Copyright,release.copyright,provider,sourceUrl);
        if(release.types?.length)mergeInjectionValue(stage.cells.Types,release.types.join(' + '),provider,sourceUrl);
        for(const label of release.labels){
            let item=[...stage.labels.children].find(node=>injectionComparable(injectionPrimaryText(node.querySelector('.entity-links'))||injectionPrimaryText(node))===injectionComparable(label.name));
            if(!item){item=injectionElement('li');item.append(injectionLabelNode(label));stage.labels.append(item);}
            else if(label.catalogNumber){
                const current=injectionPrimaryText(item).slice(injectionPrimaryText(item.querySelector('.entity-links')).length).trim();
                if(!current)item.append(' '+label.catalogNumber);
                else if(current!==label.catalogNumber)mergeInjectionValue(item,label.name+' '+label.catalogNumber,provider,label.url||sourceUrl,()=>injectionLabelNode(label));
            }
            addInjectionAttribution(item,provider,label.url||sourceUrl);
        }

        for(const link of externalLinks){
            const url=injectionUrl(link.url);if(!url)continue;
            let item=[...stage.links.children].find(node=>node.querySelector('a')?.href===url);
            if(!item){item=injectionElement('li');const anchor=injectionElement('a','',new URL(url).hostname);anchor.href=url;item.append(anchor);stage.links.append(item);}
            for(const type of link.types||[])if(![...item.querySelectorAll('.label')].some(node=>node.textContent===type))item.append(injectionElement('span','label ml-1',type));
        }
        if(release.coverArt && !stage.root.querySelector('figure.cover-image')){
            const figure=injectionElement('figure','cover-image');const link=injectionElement('a');link.href=release.coverArt;
            const image=injectionElement('img');image.src=release.coverArt;image.alt='Cover art';link.append(image);figure.append(link);
            stage.cells.Providers.closest('table').after(figure);
        }
        release.media.forEach((medium,index)=>{
            const destination=stage.media[index];
            medium.tracks.forEach((track,i)=>{
                const cells=destination.rows[i].cells;
                if(!injectionPrimaryText(cells[0]))cells[0].textContent=track.number;
                mergeInjectionValue(cells[1],track.title,provider,track.url||sourceUrl);
                mergeInjectionArtists(cells[2],track.artists,provider);
                mergeInjectionValue(cells[3],injectionDuration(track.length),provider,'');
                mergeInjectionValue(cells[4],track.isrc,provider,track.url||sourceUrl,()=>injectionElement('code','isrc',track.isrc));
            });
        });
        for(const form of stage.forms){
            // Selection and provider links were seeded before attribution rendering.
            // ISRC is displayed, not invented as an unsupported release-seed field.
            if(form.dataset.mplCreated==='1'){
                const ready=Boolean(injectionSeedValue(form,'name') && [...form.elements].some(input=>/^artist_credit\.names\./.test(input.name)&&input.value) && injectionSeedValue(form,'mediums.0.track.0.name'));
                form.querySelector('[type="submit"]').disabled=!ready;
            }
        }
        orderHarmonyProviderElements();
        debugTrace('Injection: full release applied',null,{provider:provider.id,created:stage.root.dataset.mplCreated==='1',media:release.media.length});
        return {provider:provider.id,media:release.media.length};
    }


    // =========================================================================
    // Harmony: native batch, reload continuation, then full-release providers
    // =========================================================================
    const MPL_CONTINUATION_KEY = 'hmpl-full-release-after-native-v1';

    function harmonyContinuation() {
        try {
            const value=JSON.parse(sessionStorage.getItem(MPL_CONTINUATION_KEY)||'null');
            return value?.url===location.href?value:null;
        }catch{return null;}
    }

    function getHarmonyLookupGtin() {
        const gtin=clean(new URL(location.href).searchParams.get('gtin'));
        return gtin || getHarmonyGtin();
    }
    function harmonyInputTarget() {
        return getHarmonyReleaseContext() || {
            title:'',artists:[],gtin:getHarmonyLookupGtin(),
            urls:getVisibleLookupUrls()
        };
    }

    function providerLookupInput(provider, target = {}) {
        const urls=[target.url,...(target.urls||[])].filter(Boolean);
        const url=urls.find(value=>provider.matchesReleaseUrl?.(value));
        const text=Boolean(clean(target.title) && (target.artists||[]).some(artist=>clean(artist?.name||artist)));
        const gtin=/^(?:\d{8}|\d{12,14})$/.test(clean(target.gtin));
        const policy=provider.lookupInputs||{};
        return {target:{...target,...(url?{url}:{})},direct:Boolean(url),
            searchable:text || (gtin && policy.gtinSearch===true),
            usable:Boolean(url || text || (gtin && (policy.gtinCache || policy.gtinSearch || policy.gtinBackground)))};
    }
    function filterProviderLookupInputs(providers,target){
        return providers.filter(provider=>{
            const usable=providerLookupInput(provider,target).usable;
            if(!usable)debugTrace('Core: provider deferred; no usable lookup input',null,{provider:provider.id});
            return usable;
        });
    }

    function lookupOptions(options){
        return isHarmony()?{...options,target:{...options.target,regions:options.target?.regions||new URL(location.href).searchParams.get('region')?.split(',')||[]}}:options;
    }
    function checkAcquisition(signal){if(signal?.aborted)throw new DOMException('MPL lookup cancelled','AbortError');}
    const acquisitionControllers=new Set();
    function acquisitionController(){const controller=new AbortController();acquisitionControllers.add(controller);return controller;}
    globalThis.addEventListener?.('pagehide',event=>{if(event.persisted)return;for(const controller of acquisitionControllers)controller.abort();acquisitionControllers.clear();});
    // All provider HTTP uses one cancellation-aware transport. Passive observations
    // omit a signal and remain independent of helper request lifetime.
    function providerHttp(signal,options){
        let handle,settled=false;
        const cleanup=()=>signal?.removeEventListener('abort',cancel);
        const finish=callback=>value=>{if(settled)return;settled=true;cleanup();callback?.(value);};
        const cancel=()=>{if(settled)return;settled=true;cleanup();handle?.abort?.();options.onerror?.(new DOMException('MPL lookup cancelled','AbortError'));};
        if(signal?.aborted){cancel();return;}
        signal?.addEventListener('abort',cancel,{once:true});
        try{handle=GM_xmlhttpRequest({...options,onload:finish(options.onload),onerror:finish(options.onerror),ontimeout:finish(options.ontimeout),onabort:finish(options.onabort||options.onerror)});}
        catch(error){settled=true;cleanup();throw error;}
        return handle;
    }

    function prepareProviderBatch(options){
        let queue=Promise.resolve();
        const order=orderedProviders().map(provider=>provider.id);
        return [...options].sort((a,b)=>order.indexOf(a.provider)-order.indexOf(b.provider)).map(input=>{
            const slot={options:lookupOptions(input),state:'Waiting for background lookup…',flow:null,controller:acquisitionController()};
            const flow={signal:slot.controller.signal,check(){checkAcquisition(this.signal);},progress(state){this.check();slot.state=state;slot.flow?.progress(state);}};
            slot.prepared=queue.then(()=>{
                flow.check();
                // Only a barcode already accepted into Harmony may inform later
                // searches; an unreviewed background candidate is not evidence.
                if(isHarmony()&&!slot.options.target.gtin){const gtin=getHarmonyGtin();if(gtin)slot.options.target={...slot.options.target,gtin};}
                return resolveProviderRequestWork(slot.options,flow);
            }).finally(()=>acquisitionControllers.delete(slot.controller));
            // Failures belong to this provider; later acquisition still proceeds.
            queue=slot.prepared.catch(()=>{});
            return slot;
        });
    }

    async function runHarmonyFullReleaseProviders(providers, target) {
        providers=filterProviderLookupInputs(orderedProviders(providers),{...target,urls:target.urls||getVisibleLookupUrls()});
        const batch=prepareProviderBatch(providers.map(provider=>{const direct=(target.urls||getVisibleLookupUrls()).find(url=>provider.matchesReleaseUrl?.(url));return {provider:provider.id,target:{...target,...(direct?{url:direct}:{})},want:'full-release'};}));
        for(const slot of batch){
            const provider=PROVIDERS[slot.options.provider];
            try {
                const result=await resolveProviderRequest({...slot.options,preparedSlot:slot});
                if(result.status==='found')injectFullReleaseResponse(result);
                else if(result.status==='skipped')addSkippedProvider(provider);
            }catch(error){
                debugWarn('[Harmony: More Provider Lookups]','Full-release provider failed.',provider.id,error);
                const message=injectionElement('div','message error');message.append(injectionElement('p','',provider.name+': '+error.message));
                document.querySelector('main')?.append(message);
            }
        }
        await Promise.allSettled(batch.map(slot=>slot.prepared));
        renderMplHarmonyMessage();
        setMplFlowStatus('finished');
    }

    async function applyCooperatingLookup(url) {
        // Harmony streams the release header before its tracklist. With native URLs
        // already present there is no provider work to keep this boundary open.
        // Do not mistake an installed ISRC script's initial empty payload for its
        // final decision while the document (and its ISRC cells) is still parsing.
        if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
        // Allow document-idle scripts to announce themselves, even with no native work.
        for(let i=0;i<20&&!document.documentElement.hasAttribute('data-hsri-lookup');i++)await new Promise(resolve=>setTimeout(resolve,100));
        document.dispatchEvent(new Event('harmony:consume-isrc-lookup'));
        const raw=document.documentElement.getAttribute('data-hsri-lookup-response')||document.documentElement.getAttribute('data-hsri-lookup');
        if(!raw)return;
        try{
            const handoff=JSON.parse(raw);
            debugTrace('Harmony: ISRC lookup handoff',null,handoff);
            if(!handoff.query)return;
            for(const key of handoff.remove||[])url.searchParams.delete(key);
            for(const [key,value] of new URLSearchParams(handoff.query))url.searchParams.set(key,value);
            return document.documentElement.hasAttribute('data-hsri-lookup-response');
        }catch(error){debugWarn('[Harmony: More Provider Lookups]','Invalid cooperating lookup handoff.',error);}
    }

    async function requestHarmonyProviderLookups(providers, target) {
        providers=filterProviderLookupInputs(orderedProviders(providers),target);
        const native=providers.filter(provider=>provider.harmony?.native!==false && !hasProviderUrl(provider));
        const custom=providers.filter(provider=>provider.harmony?.native===false);
        setMplFlowStatus('busy');
        const urls=[];
        // Prepare in the background while reviews remain strictly ordered.
        const batch=prepareProviderBatch(native.map(provider=>({provider:provider.id,target,want:'provider-url'})));
        for(const slot of batch){
            const provider=PROVIDERS[slot.options.provider];
            try {
                const result=await resolveProviderRequest({...slot.options,preparedSlot:slot});
                if(result.status==='found'&&result.record?.url)urls.push(result.record.url);
                else if(result.status==='skipped')addSkippedProvider(provider);
            }catch(error){debugWarn('[Harmony: More Provider Lookups]','Native provider failed.',provider.id,error);}
        }
        // Drain skipped in-flight native work before starting the next phase.
        await Promise.allSettled(batch.map(slot=>slot.prepared));
        const url=new URL(location.href);
        const commitHandoff=await applyCooperatingLookup(url);
        for(const found of urls)if(!url.searchParams.getAll('url').includes(found))url.searchParams.append('url',found);
        if(url.href!==location.href){
            if(commitHandoff){
                document.dispatchEvent(new Event('harmony:commit-isrc-lookup'));
                debugTrace('Harmony: ISRC lookup commit',null,{committed:document.documentElement.getAttribute('data-hsri-lookup-committed')});
                if(document.documentElement.getAttribute('data-hsri-lookup-committed')!=='true'){
                    // A changed/disabled proposal must not be submitted. Native URLs still proceed.
                    const original=new URL(location.href);
                    url.search=original.search;
                    for(const found of urls)if(!url.searchParams.getAll('url').includes(found))url.searchParams.append('url',found);
                }
            }
        }
        if(url.href!==location.href){
            sessionStorage.setItem(MPL_CONTINUATION_KEY,JSON.stringify({url:url.href,providers:[...new Set([...custom.map(provider=>provider.id),...injectionSeedRecords.keys()])],target}));
            debugTrace('Harmony: native batch complete; navigating once',null,{urls,custom:custom.map(provider=>provider.id)});
            location.href=url.href;
            return true;
        }
        await runHarmonyFullReleaseProviders(custom,getHarmonyReleaseContext()||target);
        return true;
    }

    function initializeHarmony() {
        const returned=consumeMplReturnLoad();
        const continuation=harmonyContinuation();
        if(!returned){sessionStorage.removeItem(MPL_SKIPPED_PROVIDERS_KEY);sessionStorage.removeItem(MPL_CONTINUATION_KEY);setMplFlowStatus('waiting');}
        else if(continuation?.providers.length)setMplFlowStatus('busy');
        injectMultiUrlStyles();
        let finished=false, snapshot=null;
        const observer=new MutationObserver(()=>{check().catch(fail);});
        function fail(error){finished=true;observer.disconnect();setMplFlowStatus('finished');debugWarn('[Harmony: More Provider Lookups]','Harmony workflow failed.',error);}
        async function check(){
            if(finished)return;
            removeDisabledProviderControls();
            separateHarmonyDistributor();
            if(!setupMultiUrlControls())return;
            for(const provider of orderedProviders())if(!setupLookupProviderControl(provider))return;
            orderHarmonyProviderElements();
            snapshot ||= captureProviderSelectionSnapshot();
            const requested=getRequestedExternalProviders(snapshot);
            const terminal=harmonyHasLookupResult() || harmonyLookupFinishedWithoutRelease() ||
                (document.readyState!=='loading' && Boolean(document.querySelector('.message.error')));
            if(returned){
                if(!terminal)return;
                finished=true;observer.disconnect();
                sessionStorage.removeItem(MPL_CONTINUATION_KEY);
                await requestHarmonyProviderLookups((continuation?.providers||[]).map(id=>PROVIDERS[id]).filter(Boolean),getHarmonyReleaseContext()||continuation?.target||harmonyInputTarget());
                return;
            }
            if(!terminal)return;
            finished=true;observer.disconnect();
            await requestHarmonyProviderLookups(requested,harmonyInputTarget());
        }
        observer.observe(document.documentElement,{childList:true,subtree:true});
        check().catch(fail);
        document.addEventListener('DOMContentLoaded',()=>check().catch(fail),{once:true});
    }


    // RESOLVER / CACHE CORE — provider-independent request lifecycle
    // =========================================================================

    /*
     * Public Harmony entry: resolveProviderRequest({ provider, target, want }).
     * Result: { provider, status, source, level, certainty, record }.
     * Provider adapters supply observations, never Harmony navigation or storage.
     * Request storage below only coordinates active helper tabs; it is NOT a cache.
     * Shared block storage receives visited-page batches. Active helper requests
     * evaluate those same observations directly, without watching cache blocks.
     */

    // =========================================================================
    // Core: active request storage and normalized observations
    // =========================================================================

    // =========================================================================
    // Cache: chronological shared blocks, bounded capacity and serialized writers
    // =========================================================================

    const CACHE_PREFIX = 'hmpl-cache-v1-';
    const CACHE_META_KEY = CACHE_PREFIX + 'blocks';
    const CACHE_LOCK_PREFIX = CACHE_PREFIX + 'writer-';
    const CACHE_LEASE_MS = 15000;
    let cacheWriteQueue = Promise.resolve();
    let externalRequest = null;

    function cacheCapacities() {
        const size = Math.max(1, Math.floor(Number(CACHE_BLOCK_SIZE) || 200));
        const total = Math.max(0, Math.floor(Number(CACHE_MAX_ENTRIES) || 0));
        const l2 = Math.min(total, Math.max(0, Math.floor(Number(CACHE_LEVEL2_BLOCKS) || 0)) * size);
        return { size, 1: total - l2, 2: l2 };
    }

    // Stable data equality: observation timestamps never turn a duplicate into new data.
    function observationSignature(record) {
        function stable(value) {
            if (Array.isArray(value)) return value.map(stable);
            if (value && typeof value === 'object') return Object.fromEntries(
                Object.keys(value).sort().filter(key => key !== 'observedAt')
                    .map(key => [key, stable(value[key])]));
            return value;
        }
        return JSON.stringify(stable(record));
    }

    function mergeObservation(older, newer) {
        const result = { ...newer };
        if (older?.provider !== newer.provider || older?.key !== newer.key) return result;
        for (const [key, value] of Object.entries(older)) {
            const current = result[key];
            if (current == null || current === '' || (Array.isArray(current) && !current.length)) result[key] = value;
        }
        return result;
    }

    // Bakery-style tickets live in script-wide GM storage (unlike origin-scoped
    // Web Locks). Leases recover from closed tabs. Expired writers abort, never
    // resume a stale write; cache failure must not prevent an active lookup.
    async function withCacheWriter(work) {
        const id = requestId();
        const key = CACHE_LOCK_PREFIX + id;
        const deadline = Date.now() + CACHE_LEASE_MS;
        const ticket = { choosing: true, number: 0, deadline };
        await GM_setValue(key, ticket);
        const readTickets = async () => {
            const keys = (await GM_listValues()).filter(item => item.startsWith(CACHE_LOCK_PREFIX));
            const result = [];
            for (const item of keys) {
                const value = await GM_getValue(item, null);
                if (value && value.deadline > Date.now()) result.push([item, value]);
                else if (value) await GM_deleteValue(item);
            }
            return result;
        };
        const assertLease = async () => {
            if (Date.now() >= deadline || !(await GM_getValue(key, null))) throw new Error('Cache writer lease expired');
        };
        try {
            ticket.number = 1 + Math.max(0, ...(await readTickets()).map(([, value]) => value.number));
            ticket.choosing = false;
            await GM_setValue(key, ticket);
            while (true) {
                await assertLease();
                const blocked = (await readTickets()).some(([otherKey, value]) => otherKey !== key &&
                    (value.choosing || value.number < ticket.number || (value.number === ticket.number && otherKey < key)));
                if (!blocked) break;
                await new Promise(resolve => setTimeout(resolve, 80));
            }
            return await work(assertLease);
        } finally {
            await GM_deleteValue(key);
        }
    }

    function storeCacheObservations(provider, observations) {
        const run = () => withCacheWriter(async assertLease => {
            const capacities = cacheCapacities();
            const meta = await GM_getValue(CACHE_META_KEY, { 1: [], 2: [] });
            meta.counts ??= {};
            const blocks = new Map();
            const dirty = new Set();
            const removed = new Set();
            async function load(key) {
                if (!blocks.has(key)) blocks.set(key, await GM_getValue(key, []));
                return blocks.get(key);
            }
            // Optional identity evidence is independent of observation richness.
            // Union only declared fields; never merge unrelated release metadata.
            const identityHistory=new Map();
            if(provider.preserveIdentityFields?.length){
                const wanted=new Set(observations.map(item=>item.record?.key || provider.getReleaseKey(item.record?.url)));
                // Each new observation carries prior evidence forward, so the
                // first newest L2/L1 record is sufficient for each identity.
                identityScan: for(const level of [2,1])for(const key of meta[level]||[]){
                    if(!wanted.size)break identityScan;
                    for(const record of [...await load(key)].reverse()){
                        if(record.provider!==provider.id || !wanted.has(record.key))continue;
                        identityHistory.set(record.key,[record]);wanted.delete(record.key);
                    }
                }
            }
            const l2Keys = new Set();
            // Once per batch, not once per card. L1 is inferior to an existing L2.
            if (observations.some(item => item.level === 1)) {
                for (const key of meta[2]) for (const record of await load(key)) l2Keys.add(record.provider + '\n' + record.key);
            }
            let inserted = 0;
            const batchChanges = DEBUG ? [] : null;
            let skippedL1Duplicate = 0;
            let skippedL1WithL2 = 0;
            for (const item of observations) {
                let record = normalizeProviderObservation(provider, item.level, item.record);
                if (!record || !capacities[record.level]) continue;
                if(provider.preserveIdentityFields?.length){
                    const history=identityHistory.get(record.key)||[];
                    const retained={};
                    for(const field of provider.preserveIdentityFields){
                        const values=[...history,record].flatMap(value=>value[field]||[]);
                        retained[field]=[...new Map(values.map(value=>[JSON.stringify(value),value])).values()];
                    }
                    const rich=history.find(value=>value.level===2);
                    if(record.level===1 && rich && provider.preserveIdentityFields.some(field=>JSON.stringify(rich[field]||[])!==JSON.stringify(retained[field])))record={...rich,...retained};
                    else Object.assign(record,retained);
                    identityHistory.set(record.key,[record,...history]);
                }
                const level = record.level;
                if (level === 1 && l2Keys.has(record.provider + '\n' + record.key)) { skippedL1WithL2++; continue; }
                if(level===2){
                    let prior;
                    findPrior: for(const blockKey of meta[2])for(const old of [...await load(blockKey)].reverse()){
                        if(old.provider===record.provider&&old.key===record.key){prior=old;break findPrior;}
                    }
                    if(prior&&observationSignature(prior)===observationSignature(mergeObservation(prior,record)))continue;
                }
                let key = meta[level][0];
                let active = key ? await load(key) : [];
                if (level === 1 && active.some(old => observationSignature(old) === observationSignature(record))) { skippedL1Duplicate++; continue; }
                if (level === 2) {
                    const index = active.findIndex(old => old.provider === record.provider && old.key === record.key);
                    if (index >= 0) {
                        const merged = mergeObservation(active[index], record);
                        active.splice(index, 1);
                        active.push({ ...merged, observedAt: Date.now() });
                        batchChanges?.push({ action: 'updated L2', blockKey: key, record: active[active.length - 1] });
                        dirty.add(key);
                        inserted++;
                        continue;
                    }
                }
                if (!key || active.length >= capacities.size) {
                    key = CACHE_PREFIX + 'l' + level + '-' + requestId();
                    active = [];
                    blocks.set(key, active);
                    meta[level].unshift(key);
                }
                active.push({ ...record, observedAt: Date.now() });
                batchChanges?.push({ action: 'appended L' + level, blockKey: key, record: active[active.length - 1] });
                dirty.add(key);
                inserted++;
                if (level === 2) l2Keys.add(record.provider + '\n' + record.key);
            }
            // Enforce exact capacities, including partial oldest blocks.
            for (const [key, block] of blocks) meta.counts[key] = block.length;
            for (const level of [2, 1]) {
                let remaining = capacities[level];
                const kept = [];
                for (const key of meta[level]) {
                    if (remaining <= 0) { removed.add(key); continue; }
                    const count = meta.counts[key] ?? (await load(key)).length;
                    if (count > remaining) {
                        blocks.set(key, (await load(key)).slice(-remaining));
                        meta.counts[key] = remaining;
                        dirty.add(key);
                    }
                    remaining -= Math.min(count, remaining);
                    kept.push(key);
                }
                meta[level] = kept;
            }
            if(!dirty.size&&!removed.size)return;
            for (const key of removed) delete meta.counts[key];
            for (const key of dirty) if (!removed.has(key)) { await assertLease(); await GM_setValue(key, blocks.get(key)); }
            await assertLease();
            await GM_setValue(CACHE_META_KEY, meta);
            for (const key of removed) { await assertLease(); await GM_deleteValue(key); }
            // Recover unreferenced blocks left by interruption during rotation.
            const retained = new Set([...meta[1], ...meta[2]]);
            for (const key of await GM_listValues()) {
                if (/^hmpl-cache-v1-l[12]-/.test(key) && !retained.has(key)) { await assertLease(); await GM_deleteValue(key); }
            }
            debugTrace('Cache: observation batch stored', null, {
                provider: provider.id, page: location.href,
                received: observations.length, inserted, skippedL1Duplicate, skippedL1WithL2,
                prunedBlocks: removed.size
            });
            if (DEBUG) {
                mplConsole.groupCollapsed(`[MPL cache] ${provider.name}: ${inserted} saved/updated of ${observations.length} observations`);
                mplConsole.info('Page:', location.href);
                mplConsole.info('Skipped:', { identicalL1: skippedL1Duplicate, existingL2: skippedL1WithL2 });
                mplConsole.info('Batch changes (oldest blocks may be pruned to capacity):', batchChanges);
                mplConsole.table(batchChanges.map(change => ({
                    action: change.action, provider: change.record.provider,
                    artist: (change.record.artists || []).join(', '), title: change.record.title,
                    level: change.record.level, url: change.record.url
                })));
                mplConsole.groupEnd();
            }
        });
        const pending = cacheWriteQueue.then(run);
        cacheWriteQueue = pending.catch(error => debugWarn('[Harmony: More Provider Lookups]', 'Cache write failed; lookup remains available.', error));
        return cacheWriteQueue;
    }

    // =========================================================================
    // Cache: explicit console inspection commands (independent of DEBUG)
    // =========================================================================

    async function readCacheSnapshot() {
        return withCacheWriter(async () => {
            const storedMeta = await GM_getValue(CACHE_META_KEY, null);
            const meta = storedMeta || { 1: [], 2: [] };
            const blocks = [];
            for (const level of [2, 1]) {
                for (let index = 0; index < meta[level].length; index++) {
                    const key = meta[level][index];
                    const records = await GM_getValue(key, []);
                    blocks.push({ level, index, key, records });
                }
            }
            return { meta, blocks, metadataBytes: storedMeta ? cacheJsonBytes(storedMeta) : 0 };
        });
    }

    function cacheEntryLabel(record) {
        return `${record.provider} - ${(record.artists || []).map(artist=>artist.name||artist).join(', ') || '[unknown artist]'} - ${record.title || '[unknown title]'}`;
    }

    function cacheJsonBytes(value) {
        // Serialized UTF-8 size, not the extension database's physical disk size.
        return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    }

    async function cacheStats() {
        const { metadataBytes, blocks } = await readCacheSnapshot();
        const providers = {};
        const levels = { 1: { blocks: 0, entries: 0, bytes: 0 }, 2: { blocks: 0, entries: 0, bytes: 0 } };
        for (const block of blocks) {
            levels[block.level].blocks++;
            levels[block.level].entries += block.records.length;
            levels[block.level].bytes += cacheJsonBytes(block.records);
            for (const record of block.records) {
                const name = record.provider || '[unknown]';
                providers[name] ??= { provider: name, entries: 0, level1: 0, level2: 0 };
                providers[name].entries++;
                providers[name]['level' + block.level]++;
            }
        }
        const serializedBytes = metadataBytes + levels[1].bytes + levels[2].bytes;
        const stats = {
            blocks: blocks.length,
            entries: levels[1].entries + levels[2].entries,
            serializedBytes,
            serializedKiB: Number((serializedBytes / 1024).toFixed(2)),
            sizeNote: 'Estimated UTF-8 JSON size of block values and metadata; not physical database/file size.',
            capacity: cacheCapacities(),
            levels,
            providers: Object.values(providers)
        };
        mplConsole.group('MPL cache statistics');
        mplConsole.table([{ blocks: stats.blocks, entries: stats.entries, serializedBytes, serializedKiB: stats.serializedKiB }]);
        mplConsole.table([2, 1].map(level => ({ level, ...levels[level], capacity: stats.capacity[level] })));
        mplConsole.table(stats.providers);
        mplConsole.info(stats.sizeNote);
        mplConsole.info('Configured capacity:', stats.capacity);
        mplConsole.groupEnd();
        return stats;
    }

    let cacheConsoleSelection=[];
    function rememberCacheSelection(records){cacheConsoleSelection=records.map(({provider,key})=>({provider,key}));}
    async function findCache(query){
        const text=String(query??'').trim().toLowerCase();
        if(!text)throw new Error('Supply text to search across all cached fields.');
        const {blocks}=await readCacheSnapshot();
        const records=blocks.flatMap(block=>[...block.records].reverse()).filter(record=>JSON.stringify(record).toLowerCase().includes(text));
        rememberCacheSelection(records);
        mplConsole.table(records.map((record,index)=>({number:index+1,release:cacheEntryLabel(record),level:record.level})));
        records.forEach((record,index)=>{mplConsole.log(`${index+1}. ${cacheEntryLabel(record)}`);mplConsole.dir(record);});
        return records;
    }
    function forgetRelease(number){
        if(!Number.isInteger(number)||number<1||number>cacheConsoleSelection.length)return Promise.reject(new Error('Use a record number from the most recent listCache or findCache in this tab.'));
        const identity={...cacheConsoleSelection[number-1]};
        if(!identity.provider||!identity.key)return Promise.reject(new Error('Record has no stable provider/key identity.'));
        const run=()=>withCacheWriter(async assertLease=>{
            const meta=await GM_getValue(CACHE_META_KEY,{1:[],2:[]});meta.counts??={};let deleted=0;
            for(const level of [1,2])for(const key of [...(meta[level]||[])]){
                const block=await GM_getValue(key,[]),remaining=block.filter(record=>record.provider!==identity.provider||record.key!==identity.key);
                if(remaining.length===block.length)continue;
                deleted+=block.length-remaining.length;await assertLease();
                if(remaining.length){await GM_setValue(key,remaining);meta.counts[key]=remaining.length;}
                else{await GM_deleteValue(key);meta[level]=meta[level].filter(value=>value!==key);delete meta.counts[key];}
            }
            if(deleted){await assertLease();await GM_setValue(CACHE_META_KEY,meta);}
            const result={...identity,deleted};mplConsole.info('MPL cache removal:',result);return result;
        });
        const pending=cacheWriteQueue.then(run);cacheWriteQueue=pending.catch(error=>debugWarn('Cache removal failed',error));return pending;
    }
    async function explainMatch(providerId){
        const provider=PROVIDERS[providerId];if(!provider)throw new Error('Unknown provider: '+providerId);
        const active=await getResolverRequest(provider);
        const target=providerLookupInput(provider,isHarmony()?harmonyInputTarget():active?.target||{}).target;
        if(!target.title&&!target.gtin&&!target.url)throw new Error('No comparison target available on this page.');
        const {blocks}=await readCacheSnapshot();
        const records=blocks.flatMap(block=>block.records).filter(record=>record.provider===provider.id);
        if(active?.current)records.unshift(active.current);
        const candidates=records.map(record=>{
            const decision={},classification=classifyProviderMatch(provider,target,record,decision);
            return {key:record.key,level:record.level,title:record.title,artists:record.artists,
                comparison:candidateNameComparison(provider,target,record),thresholdPercent:TITLE_MATCH_THRESHOLD_PERCENT,
                classification:classification||'rejected',reason:decision.reason,
                gtin:{target:normalizeComparisonGtin(target.gtin),candidate:normalizeComparisonGtin(provider.getMatchGtin?.(record)||record.gtin)},
                trackCount:{target:target.trackCount,candidate:record.trackCount},complete:fullReleaseIsComplete(record),
                acceptanceBlocker:manualAcceptanceReason(provider,{target,want:'full-release'},record)||null};
        });
        const result={provider:provider.id,target,candidates,note:'Read-only cached/current candidates; no network requests. Acceptance is separate from search eligibility.'};
        mplConsole.table(candidates.map(({key,title,level,classification,reason,acceptanceBlocker})=>({key,title,level,classification,reason,acceptanceBlocker})));
        mplConsole.dir(result);return result;
    }

    async function listCache(options = {}) {
        const compact = options === true || options?.compact === true;
        const { blocks } = await readCacheSnapshot();
        rememberCacheSelection(blocks.flatMap(block=>[...block.records].reverse()));
        const count = blocks.reduce((sum, block) => sum + block.records.length, 0);
        mplConsole.group(`MPL cache: ${count} entries in ${blocks.length} blocks (${compact ? 'compact' : 'full'})`);
        let number = 0;
        for (const block of blocks) {
            mplConsole.groupCollapsed(`L${block.level} block ${block.index} — ${block.records.length} entries`);
            if (!compact) mplConsole.info('Storage key:', block.key);
            // Match the resolver's actual traversal order within each block.
            for (const record of [...block.records].reverse()) {
                const label = `${++number}. ${cacheEntryLabel(record)}`;
                if (compact) mplConsole.log(label);
                else {
                    mplConsole.groupCollapsed(label);
                    mplConsole.dir(record);
                    mplConsole.groupEnd();
                }
            }
            mplConsole.groupEnd();
        }
        if (!count) mplConsole.info('The cache is empty.');
        mplConsole.groupEnd();
        // Keep the resolved Promise useful even when DevTools hides log output.
        let itemNumber = 0;
        return {
            blocks: blocks.length,
            entries: count,
            contents: blocks.map(block => ({
                level: block.level,
                block: block.index,
                ...(compact ? {} : { storageKey: block.key }),
                entries: [...block.records].reverse().map(record => compact
                    ? `${++itemNumber}. ${cacheEntryLabel(record)}` : record)
            }))
        };
    }

    function clearCache() {
        // Join this tab's write queue, then coordinate with writers in other tabs.
        // Do not delete ticket keys, active resolver requests or user preferences.
        const run = () => withCacheWriter(async assertLease => {
            const keys = (await GM_listValues()).filter(key =>
                key === CACHE_META_KEY || /^hmpl-cache-v1-l[12]-/.test(key));
            for (const key of keys) { await assertLease(); await GM_deleteValue(key); }
            mplConsole.info(`MPL cache cleared: removed ${keys.length} storage values. Future page observations can populate it again.`);
            return { deletedValues: keys.length };
        });
        const pending = cacheWriteQueue.then(run);
        cacheWriteQueue = pending.catch(error => debugWarn('[Harmony: More Provider Lookups]', 'Cache clear failed.', error));
        return pending;
    }

    function installCacheConsoleCommands() {
        // Expose explicit commands in the page console, not only in the
        // Tampermonkey sandbox. Firefox needs exported compartment functions.
        const api = typeof cloneInto === 'function' ? cloneInto({}, unsafeWindow) : {};
        const commands = {
            injectRelease: async response => injectFullReleaseResponse(response),
            resolveAndInject: async ({provider,target}) => { const result=await resolveProviderRequest({provider,target,want:'full-release'}); return result.status==='found'?injectFullReleaseResponse(result):result; },
            explainMatch,findCache,forgetRelease,
            cacheStats,
            listCache,
            listCacheCompact: () => listCache({ compact: true }),
            clearCache
        };
        for (const [name, command] of Object.entries(commands)) {
            const invoke = (...args) => command(...args).catch(error => {
                mplConsole.error(`MPL.${name} failed:`, error);
                throw error;
            });
            if (typeof exportFunction === 'function') exportFunction(invoke, api, { defineAs: name });
            else api[name] = invoke;
        }
        unsafeWindow.MPL = api;
        debugTrace('Cache: console commands available', null, { commands: Object.keys(commands) });
    }


    // Hooks return comparison-only copies; stored/displayed values are untouched.
    function normalizeCandidateArtist(value){
        return String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    }
    function candidateNameComparison(provider,target,record){
        const prepare=(value,side)=>provider.preprocessComparison?.(structuredClone(value),{side})||value;
        const wanted=prepare(target,'target'),found=prepare(record,'candidate');
        const credits=artists=>(artists||[]).flatMap(artist=>clean(artist?.name||artist).split(/\s*,\s*/)).map(normalizeCandidateArtist).filter(Boolean);
        const left=credits(wanted.artists),right=credits(found.artists);
        const artistsMatch=Boolean(left.length&&right.length&&left.some(artist=>right.includes(artist)));
        const similarity=titleSimilarity(wanted.title,found.title);
        return {normalized:{target:{title:normalizeTitle(wanted.title),artists:left},candidate:{title:normalizeTitle(found.title),artists:right}},
            artistsMatch,titleSimilarityPercent:similarity*100,score:artistsMatch?similarity:0};
    }
    function candidateNameScore(provider,target,record){return candidateNameComparison(provider,target,record).score;}

    function classifyProviderMatch(provider, target, record, diagnostic={}) {
        const result=(value,reason)=>{diagnostic.reason=reason;return value;};
        if(provider.isCandidateEligible && !provider.isCandidateEligible(target,record))return result(null,'Provider eligibility check failed');
        if(target.url && provider.matchesReleaseUrl(target.url)) {
            return result(provider.getReleaseKey(target.url)===record.key?'definitive':null,'Direct release URL identity comparison');
        }
        const evidence=provider.classifyEvidence?.(target,record);
        if(evidence)return result(evidence,'Provider identity evidence');
        const wantedGtin = normalizeComparisonGtin(target.gtin);
        const foundGtin = normalizeComparisonGtin(provider.getMatchGtin?.(record) || record.gtin);
        if (wantedGtin && foundGtin) return result(wantedGtin === foundGtin ? 'definitive' : null,'Barcode comparison');
        const comparison=candidateNameComparison(provider,target,record),matches=comparison.score >= TITLE_MATCH_THRESHOLD_PERCENT / 100;
        return result(matches?'navigation':null,!comparison.artistsMatch?'No shared normalized artist':matches?'Title meets threshold':'Title below threshold');
    }

    // Provider acquisition API: one newest-first read for all visible identities.
    // Modules never need to know the block layout or write storage themselves.
    async function readProviderCacheRecords(provider, keys) {
        const remaining = new Set(keys), found = new Map();
        const meta = await GM_getValue(CACHE_META_KEY, {1: [], 2: []});
        for (const level of [2, 1]) for (const blockKey of meta[level] || []) {
            if (!remaining.size) return found;
            const block = await GM_getValue(blockKey, []);
            for (let i = block.length - 1; i >= 0; i--) {
                const record = block[i];
                if (record.provider === provider.id && remaining.has(record.key)) {
                    found.set(record.key, record); remaining.delete(record.key);
                }
            }
        }
        return found;
    }

    async function findCachedProviderMatch(provider, target) {
        const candidates=new Map();
        const meta = await GM_getValue(CACHE_META_KEY, { 1: [], 2: [] });
        for (const level of [2, 1]) {
            for (const key of meta[level]) {
                const block = await GM_getValue(key, []);
                debugTrace('Cache: scanning block', null, { provider: provider.id, level, count: block.length });
                for (let index = block.length - 1; index >= 0; index--) {
                    const stored = block[index];
                    if(stored.provider!==provider.id)continue;
                    const record = normalizeProviderObservation(provider, level, stored);
                    if (!record || record.provider !== provider.id || !provider.matchesReleaseUrl(record.url)) continue;
                    const certainty = classifyProviderMatch(provider, target, record);
                    if (certainty) {
                        debugTrace('Cache -> core: qualifying candidate', null, { provider: provider.id, level, certainty, key: record.key });
                        if(!candidates.has(record.key))candidates.set(record.key,{record,certainty});
                    }
                }
            }
        }
        const matches=resolverCandidates(provider,target,[...candidates.values()].map(item=>item.record)).map(record=>({record,certainty:classifyProviderMatch(provider,target,record)}));
        return matches.length?{...matches[0],candidates:matches.map(item=>item.record)}:null;
    }

    // Tab metadata survives navigation between provider subdomains. Ordinary tabs
    // never attach to a request just because one exists in shared GM storage.
    async function getHelperRequest(provider) {
        // Capture the navigation token before yielding: site routers may consume
        // or replace the fragment while GM_getTab is still resolving.
        const hash = new URLSearchParams(location.hash.slice(1));
        const query = new URLSearchParams(location.search);
        let token = query.get('hmpl-request') || hash.get('hmpl-request');
        // SPA routers can replace the visible URL before userscript execution.
        // Navigation timing retains the original document URL, unlike location.
        if (!token && provider.helperTokenInQuery) {
            try {
                const initial = new URL(performance.getEntriesByType('navigation')[0]?.name);
                if (initial.origin === location.origin) token = initial.searchParams.get('hmpl-request') || new URLSearchParams(initial.hash.slice(1)).get('hmpl-request');
            } catch {}
        }
        const tab = await new Promise(resolve => GM_getTab(resolve));
        if (token) {
            tab.hmplRequest = { provider: provider.id, id: token };
            GM_saveTab(tab);
            hash.delete('hmpl-request');
            if (new URLSearchParams(location.hash.slice(1)).get('hmpl-request') === token)
                history.replaceState(null, '', location.pathname + location.search + (hash.size ? '#' + hash : ''));
            const cleanUrl = new URL(location.href);
            if (cleanUrl.searchParams.get('hmpl-request') === token) {
                cleanUrl.searchParams.delete('hmpl-request');
                history.replaceState(null, '', cleanUrl.href);
            }
        }
        if (tab.hmplRequest?.provider !== provider.id) {
            debugTrace('Core: provider tab has no helper binding; passive scraping only', null, {provider: provider.id, hadToken: Boolean(token)});
            return null;
        }
        const request = await getResolverRequest(provider,tab.hmplRequest.id);
        const bound = request?.id === tab.hmplRequest.id && request.state === 'resolving';
        if (!bound) debugTrace('Core: helper binding is stale or request is finished', request, {provider: provider.id});
        return bound ? request : null;
    }

    function helperNavigationUrl(url, request) {
        const parsed = new URL(url);
        if (PROVIDERS[request.provider]?.helperTokenInQuery) parsed.searchParams.set('hmpl-request', request.id);
        parsed.hash = new URLSearchParams({ 'hmpl-request': request.id }).toString();
        return parsed.href;
    }

    function providerPageIdentity() {
        const url=new URL(location.href);url.hash='';url.searchParams.delete('hmpl-request');return url.href;
    }

    async function handleProviderPage(provider, page) {
        const viewedUrl=providerPageIdentity();
        const observations = page.records.map(record => ({ level: record.level || page.level, record }));
        const request = externalRequest && await getHelperRequest(provider);
        if (!request) { if (observations.length) await storeCacheObservations(provider, observations); return; }
        if(viewedUrl!==providerPageIdentity())return;
        externalRequest = request;
        if (page.kind === 'release' && page.level === 2 && page.records.length) {
            const normalized = normalizeProviderObservation(provider, 2, page.records[0]);
            if (!normalized) return;
            const record = request.navigationCandidate?.key===normalized.key ? mergeObservation(request.navigationCandidate, normalized) : normalized;
            await storeCacheObservations(provider, [{ level: 2, record }]);
            if(viewedUrl!==providerPageIdentity())return;
            if (await submitProviderObservation(provider, request, 2, record)) return;
            // A failed cached candidate falls back once to normal provider search.
            if (request.fromCache && normalizeComparisonGtin(record.gtin) && normalizeComparisonGtin(request.target.gtin) && !gtinsMatch(record.gtin, request.target.gtin)) {
                await fallbackFromCachedCandidate(provider, request);
                return;
            }
            renderResolverPanel(provider, request);
            return;
        }
        if (observations.length) await storeCacheObservations(provider, observations);
        if (page.kind === 'search' && request.phase === 'searching') {
            const candidate = page.records.find(record => classifyProviderMatch(provider, request.target, normalizeProviderObservation(provider, record.level || page.level, record)));
            if (candidate) {
                request.navigationCandidate = normalizeProviderObservation(provider, candidate.level || page.level, candidate);
                request.phase = 'checking';
                await saveResolverRequest(provider, request);
                location.href = helperNavigationUrl(candidate.url, request);
                return;
            }
        }
        if (page.ready) {
            if (request.fromCache && page.kind !== 'search' && !page.records.length) {
                await fallbackFromCachedCandidate(provider, request);
                return;
            }
            request.current = page.kind === 'release' && page.records[0]
                ? normalizeProviderObservation(provider, page.level, page.records[0]) : null;
            request.phase = 'manual';
            await saveResolverRequest(provider, request);
            renderResolverPanel(provider, request);
        }
    }

    async function fallbackFromCachedCandidate(provider, request) {
        debugTrace('Core: cached candidate unusable; falling back to provider search', request);
        if(!providerLookupInput(provider,request.target).searchable){
            await completeResolverRequest(provider,request,'unavailable',null,'insufficient-input');return;
        }
        request.fromCache = false;
        request.navigationCandidate = null;
        request.phase = 'searching';
        await saveResolverRequest(provider, request);
        location.href = helperNavigationUrl(provider.buildSearchUrl(request.target), request);
    }

    async function initializeExternalProvider(provider) {
        if (!isProviderEnabled(provider)) return;
        externalRequest = await getHelperRequest(provider);
        if (externalRequest) {
            externalRequest.current=null;externalRequest.comparisonLocation='provider';
            await saveResolverRequest(provider,externalRequest);
            if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
            debugTrace('Core -> helper: bound request; showing panel before acquisition', externalRequest);
            try { renderResolverPanel(provider, externalRequest); }
            catch(error) { debugWarn('Helper panel rendering failed; continuing passive observation.',error); }
        }
        if (!externalRequest && provider.offerHelperReconnect) {
            if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once:true}));
            const pending = await getResolverRequest(provider);
            if (pending?.state === 'resolving') {
                const reconnect = document.createElement('button');
                reconnect.id='hmpl-helper-reconnect';
                reconnect.textContent='Connect this tab to Harmony lookup';
                reconnect.style.cssText='position:fixed;right:16px;top:80px;z-index:2147483647;padding:12px;background:#222;color:white;border:1px solid #aaa;cursor:pointer';
                reconnect.addEventListener('click',async()=>{
                    const latest=await getResolverRequest(provider,pending.id);
                    if(latest?.id!==pending.id || latest.state!=='resolving'){reconnect.remove();return;}
                    const tab=await new Promise(resolve=>GM_getTab(resolve));
                    tab.hmplRequest={provider:provider.id,id:latest.id};GM_saveTab(tab);
                    externalRequest=latest;reconnect.remove();renderResolverPanel(provider,latest);
                    const current=provider.getCurrentRelease?.();
                    if(current)await handleProviderPage(provider,{kind:'release',level:current.level||1,records:[current],ready:true});
                });
                document.body.append(reconnect);
            }
        }
        let observedUrl=providerPageIdentity();
        const navigationTimer=setInterval(()=>{
            if(providerPageIdentity()===observedUrl)return;
            observedUrl=providerPageIdentity();
            if(externalRequest?.state==='resolving'){
                externalRequest.current=null;externalRequest.navigationCandidate=null;
                renderProviderPanel({provider,target:externalRequest.target,state:'Loading current release…'});
            }
        },200);
        window.addEventListener('pagehide',()=>clearInterval(navigationTimer),{once:true});
        let pageQueue = Promise.resolve();
        provider.observePage(page => {
            const observationUrl=providerPageIdentity();
            observedUrl=observationUrl;
            pageQueue = pageQueue.then(() => observationUrl===providerPageIdentity() ? handleProviderPage(provider, page) : undefined)
                .catch(error => debugWarn('[Harmony: More Provider Lookups]', 'Provider observation failed.', error));
            return pageQueue;
        });
    }


    const resolverRequestIds=new Map(),ownedResolverKeys=new Set();
    globalThis.addEventListener?.('pagehide',event=>{if(event.persisted)return;for(const key of ownedResolverKeys)GM_deleteValue(key);ownedResolverKeys.clear();});
    function getResolverRequestKey(provider,id){
        return RESOLVER_REQUEST_KEY_PREFIX+provider.id+'-'+id;
    }
    async function pendingResolverRequests(provider){
        const prefix=RESOLVER_REQUEST_KEY_PREFIX+provider.id+'-';
        const requests=await Promise.all((await GM_listValues()).filter(key=>key.startsWith(prefix)).map(key=>GM_getValue(key,null)));
        return requests.filter(value=>value?.provider===provider.id&&value.state==='resolving');
    }
    async function getResolverRequest(provider,id=resolverRequestIds.get(provider.id)){
        if(id)return GM_getValue(getResolverRequestKey(provider,id),null);
        // Unbound provider tabs may reconnect only when the destination is unambiguous.
        if(isHarmony())return null;
        const pending=await pendingResolverRequests(provider);
        return pending.length===1?pending[0]:null;
    }
    async function saveResolverRequest(provider,session){
        await GM_setValue(getResolverRequestKey(provider,session.id),session);
    }
    async function deleteResolverRequest(provider,id){
        const key=getResolverRequestKey(provider,id);
        await GM_deleteValue(key);ownedResolverKeys.delete(key);
        if(resolverRequestIds.get(provider.id)===id)resolverRequestIds.delete(provider.id);
    }

    async function createResolverRequest(provider, target, want) {
        const request = {
            id: requestId(), provider: provider.id, want,
            state: 'resolving', phase: 'searching',
            target: { ...target, artists: [...(target.artists || [])] },
            current: null, navigationCandidate: null, result: null,
            startedAt: Date.now()
        };
        resolverRequestIds.set(provider.id,request.id);
        ownedResolverKeys.add(getResolverRequestKey(provider,request.id));
        await saveResolverRequest(provider, request);
        debugTrace('Core: request created', request, { want });
        return request;
    }

    function normalizeProviderObservation(provider, level, record) {
        if (!record) return null;
        record=provider.normalizeObservation?.(record)||record;
        const url = clean(record.url);
        if (!url || !provider.matchesReleaseUrl?.(url)) return null;
        return {
            ...record,
            provider: provider.id,
            level,
            key: clean(record.key || provider.getReleaseKey?.(url) || url),
            artists: (record.artists || (record.artist ? [record.artist] : [])).map(artist=>typeof artist==='string'?clean(artist):{...artist,name:clean(artist.name)}).filter(artist=>typeof artist==='string'?artist:artist.name),
            url
        };
    }

    async function submitProviderObservation(provider, request, level, record, { userConfirmed = false } = {}) {
        let observation = normalizeProviderObservation(provider, level, record);
        if (!observation) {
            debugTrace('Provider -> core: invalid observation ignored', request, { level, url: record?.url });
            return false;
        }
        debugTrace('Provider -> core: normalized observation received', request, {
            level, key: observation.key, url: observation.url, userConfirmed
        });
        // Passive ingestion stores the observation before helper completion.
        // Hold the exact navigation observation so L2 can inherit missing L1 data.
        const candidate = request.navigationCandidate;
        if (level === 2 && candidate?.provider === provider.id && candidate.key === observation.key) {
            debugTrace('Core: enriching L2 from held L1 candidate', request, { key: observation.key });
            observation = { ...observation };
            for (const [field, value] of Object.entries(candidate)) {
                const current = observation[field];
                if (current == null || current === '' || (Array.isArray(current) && !current.length)) {
                    observation[field] = value;
                }
            }
        }
        const latest = await getResolverRequest(provider,request.id);
        if (!latest || latest.id !== request.id || latest.state !== 'resolving') {
            debugTrace('Core: stale or terminal request ignored', request);
            return false;
        }
        Object.assign(request, latest, { current: observation });
        const urlIdentity=request.explicitUrl && provider.getReleaseKey(request.explicitUrl)===provider.getReleaseKey(observation.url);
        const sufficient=outcomeIsComplete(request.want,observation);
        const definitive=!request.requireUserConfirmation && !provider.requireUserConfirmation &&
            (provider.canAutoAccept ? provider.canAutoAccept(request.target,observation) :
                (gtinsMatch(request.target?.gtin, provider.getMatchGtin?.(observation) || observation.gtin) || urlIdentity));
        debugTrace('Core: observation evaluated', request, {
            definitive, userConfirmed,
            action: definitive || userConfirmed ? 'complete request' : 'show comparison; await user'
        });
        if ((definitive || userConfirmed) && sufficient && !trackLengthAcceptanceReason(request.target,observation)) {
            return completeResolverRequest(provider, request, 'found', observation,
                userConfirmed ? 'user-confirmed' : 'definitive');
        }
        request.phase = 'checking';
        await saveResolverRequest(provider, request);
        return false;
    }

    async function completeResolverRequest(provider, request, status, record = null, certainty = null) {
        const latest = await getResolverRequest(provider,request.id);
        if (!latest || latest.id !== request.id || latest.state !== 'resolving') {
            debugTrace('Core: stale or terminal request ignored', request);
            return false;
        }
        // Every automatic acceptance, manual acceptance and skip uses this path.
        latest.state = status;
        latest.current = record || latest.current;
        latest.finishedAt = Date.now();
        latest.result = {
            provider: provider.id, status, source: 'provider',
            level: record?.level ?? null, certainty, record
        };
        await saveResolverRequest(provider, latest);
        Object.assign(request, latest);
        debugTrace('Core: terminal response published', request, { status, certainty, level: record?.level, url: record?.url });
        return true;
    }

    function outcomeIsComplete(want,record){return want!=='full-release'||fullReleaseIsComplete(record);}
    function comparisonTracks(record){
        return record?.media?.length?record.media.flatMap((medium,index)=>(medium.tracks||[]).map(track=>({...track,disc:index+1}))):record?.tracks||[];
    }
    function trackLengthComparison(left,right){
        const known=value=>value!=null&&value!==''&&Number.isFinite(Number(value))&&Number(value)>0;
        const a=known(left),b=known(right);
        if(!a&&!b)return 'hmpl-neutral';
        if(!a||!b)return 'hmpl-mismatch';
        const difference=Math.abs(Number(left)-Number(right));
        if(difference>TRACK_LENGTH_TOLERANCE_SECONDS*1000)return 'hmpl-mismatch';
        return difference<=TRACK_LENGTH_GREEN_TOLERANCE_SECONDS*1000?'hmpl-match':'hmpl-close';
    }
    function trackLengthAcceptanceReason(target,record){
        const wanted=comparisonTracks(target),actual=comparisonTracks(record);
        for(let i=0;i<Math.min(wanted.length,actual.length);i++){
            if(trackLengthComparison(wanted[i].length,actual[i].length)==='hmpl-mismatch')
                return 'Track '+(i+1)+' lengths do not match within the allowed ±'+TRACK_LENGTH_TOLERANCE_SECONDS+' seconds, or one length is missing.';
        }
        return '';
    }
    function manualAcceptanceReason(provider,request,record){
        if(!record)return 'No current release is available yet.';
        const count=value=>{const n=Number(value?.trackCount);return n>0?n:(value?.tracks?.length||value?.media?.reduce((sum,medium)=>sum+(medium.tracks?.length||0),0)||0);};
        const expected=count(request.target),actual=count(record);
        if(expected&&actual&&expected!==actual)return 'Track counts do not match ('+expected+' expected, '+actual+' found).';
        const targetGtin=normalizeComparisonGtin(request.target?.gtin),currentGtin=normalizeComparisonGtin(record.gtin);
        if(targetGtin&&currentGtin&&!gtinsMatch(targetGtin,currentGtin))return 'The release GTINs do not match.';
        const lengthReason=trackLengthAcceptanceReason(request.target,record);if(lengthReason)return lengthReason;
        if(!outcomeIsComplete(request.want,record))return 'Release details are incomplete. A complete tracklist, title and artist are required.';
        if(provider.canManuallyAccept ? !provider.canManuallyAccept(record,request) : !provider.requireUserConfirmation)return 'This provider cannot accept the current release yet.';
        return '';
    }
    function canManuallyResolve(provider,request,record){return !manualAcceptanceReason(provider,request,record);}
    function canAutoResolveCached(provider,target,want,cached){
        return Boolean(cached?.certainty==='definitive' && (cached.candidates?.length||1)===1 && !provider.requireUserConfirmation && !trackLengthAcceptanceReason(target,cached.record) &&
            (!provider.canAutoAccept||provider.canAutoAccept(target,cached.record)) && outcomeIsComplete(want,cached.record));
    }
    function providerObservationSink(provider,signal){
        const observe=(level,record)=>{checkAcquisition(signal);return storeCacheObservations(provider,[{level,record}]);};
        observe.batch=(level,records)=>{checkAcquisition(signal);return storeCacheObservations(provider,records.map(record=>({level,record})));};
        return observe;
    }
    async function observeProviderBatch(observe,level,records){
        if(!records.length)return;
        if(observe.batch)return observe.batch(level,records);
        // Small standalone adapters/tests may supply only the single-record hook.
        for(const record of records)await observe(level,record);
    }

    async function acceptProviderRelease(provider, request, current) {
        if (!canManuallyResolve(provider,request,current)) return false;
        return submitProviderObservation(provider, request, 2, current, { userConfirmed: true });
    }

    async function skipProviderLookup(provider, request) {
        debugTrace('Helper -> core: skip requested', request);
        return completeResolverRequest(provider, request, 'skipped');
    }

    // =========================================================================
    // Core: request API, helper transport and completion
    // =========================================================================

    function watchResolverRequest(provider, request, onResult) {
        let listenerId = null;
        let settled = false;
        const consume = async value => {
            if (settled || value?.id !== request.id || !value.result) return;
            if (!['found','skipped','unavailable'].includes(value.state)) return;
            settled = true;
            debugTrace('Core transport: terminal response received; removing listener', value, { status: value.result.status });
            GM_removeValueChangeListener(listenerId);
            // Never delete a newer request that replaced this provider's session.
            const latest = await getResolverRequest(provider,request.id);
            if (latest?.id === request.id) await deleteResolverRequest(provider,request.id);
            debugTrace('Core transport -> caller: delivering response after cleanup', value);
            onResult(value.result);
        };
        listenerId = GM_addValueChangeListener(getResolverRequestKey(provider,request.id),
            (_key, _old, value) => {
                consume(value).catch(error => debugWarn('[Harmony: More Provider Lookups]', error));
            });
        debugTrace('Core transport: response listener attached', request);
        return {
            consume,
            dispose() { settled = true; GM_removeValueChangeListener(listenerId); }
        };
    }

    async function resolveProviderRequest(options) {
        options=lookupOptions(options);
        const provider=typeof options.provider==='string'?PROVIDERS[options.provider]:options.provider;
        if(!provider)throw new Error('Unknown resolver provider');
        if(!isProviderEnabled(provider))return {provider:provider.id,status:'unavailable',reason:'provider-disabled'};
        const slot=options.preparedSlot,controller=slot?.controller||acquisitionController();
        let cancelled=false,interactive=false,finishSkip;
        const skipped=new Promise(resolve=>finishSkip=resolve);
        const abort=()=>checkAcquisition(controller.signal);
        const flow={signal:controller.signal,check:abort,progress:state=>{
            abort();
            renderProviderPanel({provider,target:options.target,state,loading:true,actions:[{label:'Skip '+provider.name,onClick:()=>{
                if(interactive||cancelled)return;
                cancelled=true;controller.abort();document.querySelector('#'+PROVIDER_PANEL_ID)?.remove();
                finishSkip({provider:provider.id,status:'skipped',source:'user'});
            }}]});
        },handoff:()=>{abort();interactive=true;}};
        if(slot){slot.flow=flow;flow.progress(slot.state);}
        const preparation=slot?slot.prepared:resolveProviderRequestWork(options,flow);
        const work=preparation.then(prepared=>{flow.check();return prepared.review?prepared.review(flow):prepared;}).then(result=>{
            if(!cancelled&&!interactive)document.querySelector('#'+PROVIDER_PANEL_ID)?.remove();return result;
        },error=>{if(!cancelled&&!interactive)document.querySelector('#'+PROVIDER_PANEL_ID)?.remove();if(cancelled)return {provider:provider.id,status:'skipped'};throw error;});
        return Promise.race([work,skipped]).finally(()=>{if(slot)slot.flow=null;acquisitionControllers.delete(controller);});
    }

    async function resolveProviderRequestWork({ provider, target, want = 'provider-url' },flow) {
        if (typeof provider === 'string') provider = PROVIDERS[provider];
        if (!provider) throw new Error('Unknown resolver provider');
        if(!isProviderEnabled(provider))return {provider:provider.id,status:'unavailable',reason:'provider-disabled'};
        const input=providerLookupInput(provider,target);target=input.target;
        const unavailable=()=>({provider:provider.id,status:'unavailable',reason:'insufficient-input'});
        if(!input.usable){debugTrace('Core: resolution deferred; no usable input',null,{provider:provider.id});return unavailable();}
        // Responses carry observations; full-release requests also require a
        // complete tracklist and the provider's automatic-acceptance policy.
        if (!['provider-url','full-release'].includes(want)) throw new Error('Unsupported resolver outcome: ' + want);
        // Collect qualifying observations, preferring L2 over duplicate L1 identities.
        debugTrace('Harmony -> core: outcome requested', null, { provider: provider.id, want });
        flow.progress('Checking cache…');
        let cached = null;
        try { cached = await findCachedProviderMatch(provider, target); }
        catch (error) { debugWarn('[Harmony: More Provider Lookups]', 'Cache read failed; using provider search.', error); }
        flow.check();
        const verifyBarcode=needsBarcodeSearch(provider,target,cached?.candidates||[]);
        if (!verifyBarcode&&canAutoResolveCached(provider,target,want,cached)) {
            return { provider: provider.id, status: 'found', source: 'cache',
                level: cached.record.level, certainty: 'definitive', record: cached.record };
        }
        flow.check();
        let interactionUrl=null,interactionReason=null,barcodeUnverified=false;
        if(provider.backgroundSearch || provider.backgroundEnrich){
            try{
                const acquired=await acquireBackgroundCandidate(provider,target,want,cached?.record,flow,cached?.candidates);
                flow.check();
                barcodeUnverified=Boolean(acquired?.barcodeUnverified);
                if(acquired?.status==='candidate')cached={record:acquired.record,candidates:acquired.candidates,certainty:classifyProviderMatch(provider,target,acquired.record)||'possible'};
                if(acquired?.status==='interaction-required'){interactionUrl=acquired.url;interactionReason=acquired.reason;cached=acquired.candidates?.length?{record:acquired.candidates[0],candidates:acquired.candidates,certainty:'possible'}:null;}
            }catch(error){debugWarn('Background acquisition requires interactive fallback',provider.id,error);}
        }
        flow.check();
        if(cached)barcodeUnverified=needsBarcodeSearch(provider,target,[cached.record]);
        if(!cached && !interactionUrl && !input.direct && !input.searchable){
            debugTrace('Core: no usable helper search after cache/background lookup',null,{provider:provider.id});
            return unavailable();
        }
        if(canAutoResolveCached(provider,target,want,cached))
            return {provider:provider.id,status:'found',source:'cache',level:cached.record.level,certainty:'definitive',record:cached.record};
        return {review:async reviewFlow=>{
        reviewFlow.handoff();
        const request = await createResolverRequest(provider, target, want);
        request.interactionReason=interactionReason;request.barcodeUnverified=barcodeUnverified;
        if (cached) {
            request.navigationCandidate = cached.record;
            request.fromCache = true;
            request.phase = 'checking';
            await saveResolverRequest(provider, request);
        }
        const destination=interactionUrl || cached?.record.url || (target.url && provider.matchesReleaseUrl(target.url) ? target.url : provider.buildSearchUrl(target));
        if(target.url && provider.matchesReleaseUrl(target.url)){request.explicitUrl=target.url;request.phase='checking';await saveResolverRequest(provider,request);}
        return presentResolverRequest(provider, request, cached?.record, destination,cached?.candidates);
        }};
    }

    // Optional provider hooks: backgroundSearch({target,want,observe,signal}) and
    // backgroundEnrich({target,want,record,observe,signal}). Providers pass the
    // signal through acquisition requests; passive observation has no signal.
    // Results: {status:'candidate',record}, {status:'no-match'}, or
    // {status:'interaction-required',url,reason}. Identity consolidation and manual
    // search URLs may be supplied by prepareCandidates/buildManualSearchUrl.
    function hasMatchingBarcode(provider,target,record){
        return Boolean(record&&((normalizeComparisonGtin(record.gtin)&&gtinsMatch(record.gtin,target.gtin))||provider.hasBarcodeEvidence?.(target,record)));
    }
    function needsBarcodeSearch(provider,target,candidates){
        return Boolean(provider.lookupInputs?.barcodeBeforeTextCache&&/^\d{8}$|^\d{12,14}$/.test(clean(target.gtin))&&
            !providerLookupInput(provider,target).direct&&!candidates.some(record=>hasMatchingBarcode(provider,target,record)));
    }
    function resolverCandidates(provider,target,records){
        const unique=new Map();
        for(const raw of records){
            const record=normalizeProviderObservation(provider,raw.level||1,raw);
            if(record&&classifyProviderMatch(provider,target,record)){
                const prior=unique.get(record.key);
                if(!prior)unique.set(record.key,record);
                else{
                    const merged=record.level>prior.level?mergeObservation(prior,record):mergeObservation(record,prior);
                    for(const field of provider.preserveIdentityFields||[])merged[field]=[...new Map([...(prior[field]||[]),...(record[field]||[])].map(value=>[JSON.stringify(value),value])).values()];
                    unique.set(record.key,merged);
                }
            }
        }
        return (provider.prepareCandidates?.(target,[...unique.values()])||[...unique.values()]).sort((a,b)=>{
            const score=r=>(provider.lookupInputs?.barcodeBeforeTextCache&&hasMatchingBarcode(provider,target,r)?4:0)+(classifyProviderMatch(provider,target,r)==='definitive'?2:candidateNameScore(provider,target,r));
            return score(b)-score(a);
        });
    }
    async function acquireBackgroundCandidate(provider,target,want,candidate,flow={check(){},progress(){}},initial=[]){
        const collected=[...(initial||[]),...(candidate?[candidate]:[])],sink=providerObservationSink(provider,flow.signal);
        const observe=async(level,record)=>{collected.push({...record,level:record.level||level});return sink(level,record);};
        observe.batch=async(level,records)=>{collected.push(...records.map(record=>({...record,level:record.level||level})));return sink.batch(level,records);};
        const verifyBarcode=Boolean(candidate&&needsBarcodeSearch(provider,target,[...collected,candidate]));
        let barcodeUnverified=false;
        let outcome=candidate?{status:'candidate',record:candidate}:null;
        if(verifyBarcode&&provider.backgroundSearch){
            flow.progress('Verifying barcode…');
            outcome=await provider.backgroundSearch({target,want,observe,signal:flow.signal,barcodeOnly:true});flow.check();
            if(outcome?.record)collected.push(outcome.record);
            const available=resolverCandidates(provider,target,collected);
            barcodeUnverified=!available.some(record=>hasMatchingBarcode(provider,target,record));
            if(outcome?.status==='interaction-required')return {...outcome,candidates:available,barcodeUnverified};
            candidate=available[0]||null;
            outcome=candidate?{status:'candidate',record:candidate}:outcome;
        }
        if(!candidate&&!verifyBarcode&&provider.backgroundSearch){flow.progress('Searching…');outcome=await provider.backgroundSearch({target,want,observe,signal:flow.signal});flow.check();}
        if(outcome?.record)collected.push(outcome.record);
        let candidates=resolverCandidates(provider,target,collected);
        if(!candidates.length&&outcome?.record)candidates=[outcome.record];
        if(candidates.length){
            const selected=candidates[0];
            flow.progress('Loading release details…');
            outcome=await enrichResolverCandidate(provider,target,want,selected,flow.signal);
            flow.check();
            if(outcome.record)candidates[0]=outcome.record;
            candidates=resolverCandidates(provider,target,candidates);
            return {...outcome,...(outcome.record?{record:candidates[0]}:{}),candidates,barcodeUnverified};
        }
        return {...outcome,barcodeUnverified};
    }
    async function enrichResolverCandidate(provider,target,want,record,signal){
        checkAcquisition(signal);
        record=normalizeProviderObservation(provider,record.level||1,record);
        const cached=(await readProviderCacheRecords(provider,[record.key])).get(record.key);
        if(cached&&cached.level===2&&outcomeIsComplete(want,cached))record=normalizeProviderObservation(provider,2,mergeObservation(record,cached));
        let outcome={status:'candidate',record};
        if(provider.backgroundEnrich&&(record.level!==2||!outcomeIsComplete(want,record)))
            outcome=await provider.backgroundEnrich({target,want,record,observe:providerObservationSink(provider,signal),signal});
        checkAcquisition(signal);
        if(outcome.record){
            outcome.record=normalizeProviderObservation(provider,outcome.record.level||2,mergeObservation(record,outcome.record));
            // Displaying a cache hit is not a new observation. Ignore timestamps when
            // comparing, but retain writes for new metadata and L1-to-L2 upgrades.
            const prior=cached&&normalizeProviderObservation(provider,cached.level,cached);
            if(!prior||observationSignature(prior)!==observationSignature(outcome.record))
                await storeCacheObservations(provider,[{level:outcome.record.level,record:outcome.record}]);
        }
        return outcome;
    }

    function presentResolverRequest(provider,request,candidate,destination,candidates=[]){
        return new Promise((resolve,reject)=>{
            let helperTab=null,busy=false,index=0,candidateController=null;
            const choices=candidates?.length?[...candidates]:candidate?[candidate]:[];
            const onKey=event=>{
                if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||busy||helperTab||choices.length<2)return;
                if(event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))return;
                const panel=document.querySelector('#'+PROVIDER_PANEL_ID);
                if(!panel||panel.dataset.collapsed==='true')return;
                if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;
                event.preventDefault();select(event.key==='ArrowLeft'?-1:1);
            };
            document.addEventListener('keydown',onKey);
            const removePanel=()=>{candidateController?.abort();document.removeEventListener('keydown',onKey);document.querySelector('#'+PROVIDER_PANEL_ID)?.remove();};
            const watcher=watchResolverRequest(provider,request,result=>{removePanel();helperTab?.close();resolve(result);});
            const fail=error=>{watcher.dispose();removePanel();reject(error);};
            const latest=async()=>{const value=await getResolverRequest(provider,request.id);return value?.id===request.id&&value.state==='resolving'?value:null;};
            const open=async url=>{
                if(busy||helperTab)return;busy=true;
                try{
                    const value=await latest();if(!value)return;
                    value.comparisonLocation='provider';value.current=null;
                    value.navigationCandidate=null;value.fromCache=false;value.phase='manual';
                    choices.length=0;
                    await saveResolverRequest(provider,value);
                    helperTab=GM_openInTab(helperNavigationUrl(url,value),{active:true,insert:true,setParent:true});
                    renderProviderPanel({provider,target:value.target,warning:Boolean(value.interactionReason),state:'Comparison continues on '+provider.name+'.',message:'Use the helper on the provider page to select the currently viewed release.'});
                    helperTab.onclose=async()=>{try{const pending=await latest();if(pending)await skipProviderLookup(provider,pending);await watcher.consume(await getResolverRequest(provider,request.id));}catch(error){fail(error);}};
                }catch(error){fail(error);}finally{busy=false;}
            };
            const draw=()=>{
                const ready=candidate?.level===2&&outcomeIsComplete(request.want,candidate);
                const captcha=request.interactionReason==='captcha';
                const actions=[{label:captcha?'Resolve CAPTCHA':candidate?'View release':request.interactionReason?'Open website':'Manual search',disabled:busy,onClick:()=>open(candidate?.url||destination)}];
                actions.unshift({label:'Use this release',disabled:busy||!canManuallyResolve(provider,request,candidate),title:manualAcceptanceReason(provider,request,candidate),onClick:async()=>{
                    if(busy)return;busy=true;
                    try{const value=await latest();if(value?.comparisonLocation==='harmony'){await acceptProviderRelease(provider,value,value.current);await watcher.consume(await getResolverRequest(provider,request.id));}}catch(error){fail(error);}finally{busy=false;}
                }});
                if(candidate&&providerLookupInput(provider,request.target).searchable)actions.push({label:'Manual search',disabled:busy,onClick:()=>open(provider.buildManualSearchUrl?.(request.target,candidate)||provider.buildSearchUrl(request.target))});
                actions.push({label:'Skip '+provider.name,onClick:async()=>{try{const value=await latest();if(value)await skipProviderLookup(provider,value);await watcher.consume(await getResolverRequest(provider,request.id));}catch(error){fail(error);}}});
                renderProviderPanel({provider,target:request.target,current:candidate,loading:busy,
                    warning:Boolean(request.interactionReason),
                    state:captcha?'CAPTCHA detected — manual verification required':busy?'Loading release details…':ready?'Compare release':request.interactionReason?'Website interaction required':candidate?'Release details need to be loaded':'No background candidate available',
                    message:request.barcodeUnverified?'Barcode verification is incomplete. This candidate is unverified against the barcode.'+(captcha?' Open '+provider.name+' and complete its CAPTCHA to continue.':''):captcha?'Open '+provider.name+' and complete its CAPTCHA to continue, or skip this provider.':ready?'Review this candidate, or visit its website for more details.':'Open the website to continue searching, or skip this provider.',actions,
                    candidateNavigation:choices.length>1?{index,count:choices.length,disabled:busy,previous:()=>select(-1),next:()=>select(1)}:null});
            };
            const select=async direction=>{
                if(busy||helperTab)return;busy=true;index=(index+direction+choices.length)%choices.length;candidate=choices[index];draw();
                try{
                    candidateController=acquisitionController();
                    const outcome=await enrichResolverCandidate(provider,request.target,request.want,candidate,candidateController.signal);
                    const value=await latest();if(!value||value.comparisonLocation!=='harmony')return;
                    candidate=outcome.record||candidate;choices[index]=candidate;
                    const unique=resolverCandidates(provider,request.target,choices);
                    choices.splice(0,choices.length,...unique);
                    index=Math.max(0,choices.findIndex(record=>record.key===candidate.key));candidate=choices[index]||candidate;
                    request={...value,current:candidate,interactionReason:outcome.reason||null};
                    await saveResolverRequest(provider,request);
                }catch(error){debugWarn('Candidate enrichment failed',error);const value=await latest();if(value?.comparisonLocation==='harmony'){candidate=null;request={...value,current:null};await saveResolverRequest(provider,request);}}
                finally{acquisitionControllers.delete(candidateController);candidateController=null;busy=false;const value=await latest();if(value?.comparisonLocation==='harmony')draw();}
            };
            (async()=>{request.comparisonLocation='harmony';request.current=candidate||null;
                if(choices.length>1)request.requireUserConfirmation=true;
                await saveResolverRequest(provider,request);draw();
            })().catch(fail);
        });
    }

    // =========================================================================
    // Core: candidate navigation and provider-page lifecycle
    // =========================================================================









    // =========================================================================
    // Core: generic comparison UI and user actions
    // =========================================================================

    function injectProviderPanelStyles() {
        if (
            $('#hmpl-provider-panel-styles')
        ) {
            return;
        }

        const style =
            document.createElement(
                'style'
            );

        style.id =
            'hmpl-provider-panel-styles';

        style.textContent = `
            #${PROVIDER_PANEL_ID} {
                position: fixed;
                right: 18px;
                bottom: 18px;
                z-index: 2147483647;

                width: 390px;
                box-sizing: border-box;

                padding: 0;
                overflow: hidden;
                max-width: calc(100vw - 24px);

                background: #fff;
                color: #222;

                border: 1px solid rgba(0, 0, 0, 0.25);
                border-radius: 8px;

                box-shadow:
                    0 4px 18px rgba(0, 0, 0, 0.28);

                font-family:
                    Arial,
                    Helvetica,
                    sans-serif;

                font-size: 13px;
                line-height: 1.4;
            }

            #${PROVIDER_PANEL_ID} * {
                box-sizing: border-box;
            }

            #${PROVIDER_PANEL_ID} .hmpl-panel-title {
                font-size: 15px;
                font-weight: 700;
                margin: 0;
            }

            #${PROVIDER_PANEL_ID} .hmpl-panel-state {
                margin-bottom: 11px;
                font-weight: 600;
            }

            #${PROVIDER_PANEL_ID} .hmpl-panel-message {
                margin-top: 10px;
            }

            #${PROVIDER_PANEL_ID} .hmpl-panel-actions {
                display: flex;
                justify-content: flex-end;
                gap: 7px;
                margin-top: 12px;
            }


            #${PROVIDER_PANEL_ID} .hmpl-comparison-table {
                width: 100%;
                margin-top: 10px;
                border-collapse: collapse;
                table-layout: fixed;
            }

            #${PROVIDER_PANEL_ID} .hmpl-comparison-table th,
            #${PROVIDER_PANEL_ID} .hmpl-comparison-table td {
                padding: 4px 5px;
                text-align: left;
                vertical-align: top;
                overflow-wrap: anywhere;
            }

            #${PROVIDER_PANEL_ID} .hmpl-comparison-table th {
                font-weight: 700;
            }

            #${PROVIDER_PANEL_ID} .hmpl-comparison-label {
                width: 74px;
                color: #666;
                font-weight: normal;
            }

            #${PROVIDER_PANEL_ID} .hmpl-match {
                color: #168000;
                font-weight: 600;
            }

            #${PROVIDER_PANEL_ID} .hmpl-mismatch {
                color: #c00000;
                font-weight: 600;
            }

            #${PROVIDER_PANEL_ID} .hmpl-neutral {
                color: #777;
                font-weight: 400;
            }

            #${PROVIDER_PANEL_ID} .hmpl-unpaired {
                color: #c00000;
                font-weight: 600;
            }

            #${PROVIDER_PANEL_ID} .hmpl-cover-art {
                display: block;
                width: 120px;
                height: 120px;
                object-fit: contain;
                border-radius: 3px;
            }

            #${PROVIDER_PANEL_ID} .hmpl-cover-row td {
                padding-top: 6px;
                padding-bottom: 10px;
            }

#hmpl-provider-panel .hmpl-panel-title {display:flex;align-items:center;gap:10px;margin:0;padding:10px;background:var(--hmpl-provider-color,#333);color:white;line-height:1.3}
#hmpl-provider-panel .hmpl-panel-heading {flex:1;min-width:0}
#hmpl-provider-panel .hmpl-panel-heading span {display:block;color:white;font:inherit}
#hmpl-provider-panel .hmpl-panel-logo {display:flex;flex:0 0 40px;color:white}
#hmpl-provider-panel .hmpl-panel-logo svg {width:40px;height:40px;display:block;color:white}
#hmpl-provider-panel .hmpl-panel-body {padding:12px 16px 14px;max-height:calc(100vh - 110px);overflow-y:auto}
#hmpl-provider-panel[data-collapsed="true"] .hmpl-panel-body {display:none}
#hmpl-provider-panel button {all:unset;box-sizing:border-box;cursor:pointer;font:600 13px/1.25 Arial,Helvetica,sans-serif;text-align:center;color:white;background:var(--hmpl-provider-color,#333);border:1px solid rgba(0,0,0,.25);border-radius:4px;padding:9px 10px;min-height:36px;text-shadow:0 1px 2px rgba(0,0,0,.35)}
#hmpl-provider-panel .hmpl-warning-icon {font-weight:400 !important;font-size:14px !important}
#hmpl-provider-panel .hmpl-close {color:#b85c00;font-weight:600}
#hmpl-provider-panel button:hover {filter:brightness(.88)}
#hmpl-provider-panel button:disabled {background:#999;color:#eee;cursor:not-allowed;filter:none;text-shadow:none}
#hmpl-provider-panel button:focus-visible {outline:2px solid #222;outline-offset:2px}
#hmpl-provider-panel .hmpl-panel-toggle {flex:0 0 28px;padding:4px;border-color:rgba(255,255,255,.6);font-size:20px;min-height:30px}
#hmpl-provider-panel .hmpl-panel-toggle:focus-visible {outline-color:white}
#hmpl-provider-panel .hmpl-panel-actions button {flex:1}
#hmpl-provider-panel .hmpl-track-toggle {all:unset;cursor:pointer;color:#444;font:bold 15px Arial;padding:0 2px}
#hmpl-provider-panel .hmpl-track-table {font:inherit;width:100%;table-layout:fixed;border-collapse:collapse}
#hmpl-provider-panel .hmpl-track-table th:first-child {width:24px}
#hmpl-provider-panel .hmpl-track-table td {border-top:1px solid #ddd}
#hmpl-provider-panel .hmpl-track-details[hidden] {display:none}
#hmpl-provider-panel .hmpl-header-status {display:none;font-size:11px;font-weight:400;margin-top:3px}
#hmpl-provider-panel[data-collapsed="true"] .hmpl-header-status {display:block}
#hmpl-provider-panel[data-loading="true"] .hmpl-panel-state::before {content:"";display:inline-block;width:10px;height:10px;margin-right:7px;border:2px solid #ccc;border-top-color:var(--hmpl-provider-color);border-radius:50%;animation:hmpl-spin 1s linear infinite}
@keyframes hmpl-spin {to {transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){#hmpl-provider-panel .hmpl-panel-state::before{animation:none}}
#hmpl-provider-panel .hmpl-comparison-table {font:inherit;color:inherit}
#hmpl-provider-panel .hmpl-comparison-label {white-space:nowrap}
        `;

        (
            document.head ||
            document.documentElement
        ).append(
            style
        );
    }

    function comparisonCell(
        value,
        className = ''
    ) {
        const cell =
            document.createElement(
                'td'
            );

        cell.textContent =
            value === null ||
            value === undefined ||
            value === ''
                ? '[unknown]'
                : String(value);

        if (className) {
            cell.className =
                className;
        }

        return cell;
    }

    function comparisonArtworkSources(source){
        const candidates=[];
        try{
            const url=new URL(source);
            // SoundCloud's "large" rendition is a thumbnail, not the original.
            const suffix=/-(?:large|badge|small|tiny|mini|crop|t\d+x\d+)\.(?:jpg|jpeg|png|webp)$/i;
            if(/(^|\.)sndcdn\.com$/.test(url.hostname)&&suffix.test(url.pathname)){
                const base=url.pathname.replace(suffix,'');
                for(const ending of ['-original.jpg','-original.png','-t500x500.jpg']){
                    const full=new URL(url);full.pathname=base+ending;candidates.push(full.href);
                }
            }else if(url.hostname==='artwork-cdn.7static.com'){
                // Size sequence from MaxURL's 7digital rule (issue #922).
                const sizePath=/^(\/+static\/+img\/+[^/]+\/+[0-9]{2}\/+[0-9]{3}\/+[0-9]{3}\/+[0-9]+_)([0-9]+)(\.)/;
                const match=url.pathname.match(sizePath);
                if(match){
                    const currentSize=Number(match[2]);
                    if(currentSize>=800)candidates.push(source);
                    for(const size of [800,500,350,200]){
                        const full=new URL(url);full.pathname=url.pathname.replace(sizePath,(_,prefix,oldSize,dot)=>prefix+size+dot);candidates.push(full.href);
                    }
                }
            }
        }catch{}
        return [...new Set([...candidates,source].filter(Boolean))];
    }

    function showCoverComparison(leftUrl,rightUrl){
        document.getElementById('hmpl-cover-comparison')?.close();
        const dialog=document.createElement('dialog');dialog.id='hmpl-cover-comparison';
        dialog.setAttribute('aria-label','Cover artwork comparison');
        const style=document.createElement('style');
        style.textContent=`
#hmpl-cover-comparison {position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;box-sizing:border-box!important;margin:0!important;padding:16px!important;border:0!important;background:#111!important;color:white!important;font:14px Arial,sans-serif!important;overflow:hidden!important;}
#hmpl-cover-comparison::backdrop {background:#111;}
#hmpl-cover-comparison .hmpl-cover-controls {display:flex!important;align-items:center!important;gap:12px!important;flex-wrap:wrap!important;min-height:72px!important;}
#hmpl-cover-comparison .hmpl-cover-controls button {margin:0!important;}
#hmpl-cover-comparison .hmpl-cover-fade {display:flex!important;align-items:center!important;gap:8px!important;color:white!important;}
#hmpl-cover-comparison .hmpl-cover-fade[hidden] {display:none!important;}
#hmpl-cover-comparison input[type=range] {width:180px!important;max-width:30vw!important;accent-color:#ddd!important;}
#hmpl-cover-comparison[data-overlay=true] .hmpl-cover-pair {display:grid!important;grid-template-columns:1fr!important;grid-template-rows:1fr!important;gap:0!important;}
#hmpl-cover-comparison[data-overlay=true] figure {grid-area:1 / 1!important;align-self:center!important;justify-self:center!important;}
#hmpl-cover-comparison[data-overlay=true] figcaption {display:none!important;}
#hmpl-cover-comparison .hmpl-cover-pair {display:flex!important;align-items:center!important;justify-content:center!important;gap:16px!important;height:calc(100% - 96px)!important;}
#hmpl-cover-comparison figure {margin:0!important;padding:0!important;flex:1 1 0!important;min-width:0!important;text-align:center!important;}
#hmpl-cover-comparison figcaption {color:white!important;margin:0 0 12px!important;font:14px Arial,sans-serif!important;}
#hmpl-cover-comparison img {display:block!important;margin:auto!important;padding:0!important;border:0!important;max-width:none!important;max-height:none!important;object-fit:contain!important;}
#hmpl-cover-comparison button {display:block!important;margin:0 0 12px auto!important;padding:6px 12px!important;background:#333!important;color:white!important;border:1px solid #aaa!important;border-radius:4px!important;font:14px Arial,sans-serif!important;cursor:pointer!important;}
`;
        const close=document.createElement('button');close.type='button';close.textContent='Close ×';close.setAttribute('aria-label','Close artwork comparison');
        close.addEventListener('click',()=>dialog.close());
        const pair=document.createElement('div');pair.className='hmpl-cover-pair';
        const controls=document.createElement('div');controls.className='hmpl-cover-controls';
        const mode=document.createElement('button');mode.type='button';mode.textContent='Overlay';mode.disabled=true;mode.setAttribute('aria-pressed','false');
        const fade=document.createElement('div');fade.className='hmpl-cover-fade';fade.hidden=true;
        const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max='100';slider.value='50';slider.setAttribute('aria-label','Fade from looking-for artwork to current artwork');
        const ab=document.createElement('button');ab.type='button';ab.textContent='A/B';ab.title='Switch between looking-for and current artwork';
        fade.append('Looking for',slider,'Current',ab);controls.append(mode,fade,close);
        let overlay=false;
        const images=[];
        const blend=()=>{images.forEach((img,index)=>img.style.setProperty('opacity',overlay&&index===1?String(Number(slider.value)/100):'1','important'));slider.setAttribute('aria-valuetext',slider.value+'% current artwork');};
        slider.addEventListener('input',blend);
        ab.addEventListener('click',()=>{slider.value=Number(slider.value)===0?'100':'0';blend();});
        mode.addEventListener('click',()=>{overlay=!overlay;dialog.dataset.overlay=String(overlay);mode.textContent=overlay?'Side by side':'Overlay';mode.setAttribute('aria-pressed',String(overlay));fade.hidden=!overlay;blend();layout();});
        const layout=()=>{
            const loaded=images.filter(img=>img.isConnected&&img.naturalWidth&&img.naturalHeight);
            mode.disabled=loaded.length!==2;
            if(mode.disabled&&overlay){overlay=false;dialog.dataset.overlay='false';mode.textContent='Overlay';mode.setAttribute('aria-pressed','false');fade.hidden=true;blend();}
            if(!loaded.length)return;
            const width=Math.max(1,Math.min(...loaded.map(img=>img.naturalWidth),overlay?dialog.clientWidth-32:(dialog.clientWidth-48)/2));
            const height=Math.max(1,Math.min(...loaded.map(img=>img.naturalHeight),dialog.clientHeight-160));
            for(const img of loaded){const scale=Math.min(1,width/img.naturalWidth,height/img.naturalHeight);img.style.setProperty('width',img.naturalWidth*scale+'px','important');img.style.setProperty('height',img.naturalHeight*scale+'px','important');}
        };
        for(const [label,url] of [['Looking for:',leftUrl],['Current:',rightUrl]]){
            const figure=document.createElement('figure'),caption=document.createElement('figcaption'),status=document.createElement('span');caption.textContent=label;figure.append(caption,status);
            status.textContent=url?'Loading artwork…':'Artwork unavailable';
            if(url){const img=document.createElement('img');img.alt=label+' cover artwork';img.style.visibility='hidden';images.push(img);
                img.addEventListener('load',()=>{status.remove();layout();img.style.visibility='visible';});
                const sources=comparisonArtworkSources(url);let sourceIndex=0;
                img.addEventListener('error',()=>{if(++sourceIndex<sources.length){img.src=sources[sourceIndex];return;}status.textContent='Artwork could not be loaded';img.remove();layout();});
                figure.append(img);img.src=sources[0];
            }pair.append(figure);
        }
        dialog.append(style,controls,pair);document.body.append(dialog);
        dialog.addEventListener('keydown',event=>event.stopPropagation());
        dialog.addEventListener('close',()=>{window.removeEventListener('resize',layout);dialog.remove();},{once:true});
        window.addEventListener('resize',layout);dialog.showModal();layout();close.focus();
    }

    function comparisonImageCell(url) {
        const cell =
            document.createElement(
                'td'
            );

        cell.className =
            'hmpl-neutral';

        if (!url) {
            cell.textContent =
                '[unknown]';

            return cell;
        }

        const image =
            document.createElement(
                'img'
            );

        const sources=comparisonArtworkSources(url);let sourceIndex=0;
        image.addEventListener('error',()=>{if(++sourceIndex<sources.length)image.src=sources[sourceIndex];});
        image.src=sources[0];

        image.alt =
            'Cover art';

        image.loading =
            'eager';

        image.className =
            'hmpl-cover-art';

        cell.append(
            image
        );

        return cell;
    }

    // Every field accepts scalars, arrays or {value, assumption?, notifier?}.
    // A wrapper around an array passes its annotations to each candidate.
    // These display candidates never change resolver certainty or seeder fields.
    function comparisonValues(input) {
        const expand=(item, inherited={})=>{
            if(Array.isArray(item))return item.flatMap(value=>expand(value,inherited));
            if(item && typeof item==='object'){
                const {value,...annotations}=item;
                return expand(value,{...inherited,...annotations});
            }
            return item==null || item==='' ? [] : [{...inherited,value:item}];
        };
        return expand(input);
    }

    function comparisonValuesMatch(type, wanted, current) {
        return comparisonValues(wanted).some(left => comparisonValues(current).some(right => valuesMatch(type,left.value,right.value)));
    }

    function comparisonDateDay(value){
        const date=String(value);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
        const time=Date.parse(date+'T00:00:00Z');
        return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===date?time/86400000:null;
    }

    // Display-only alignment: retain source offsets and never alter stored values.
    function comparisonTextParts(value,other,type){
        const text=String(value),peers=comparisonValues(other);
        if(type==='artist'){
            const credits=peers.flatMap(peer=>String(peer.value).split(',').map(name=>name.trim())).filter(Boolean);
            return text.split(/(,\s*)/).filter(Boolean).map(part=>{
                if(/^,\s*$/.test(part))return {text:part,className:'hmpl-neutral'};
                const name=part.trim(),key=normalizeCandidateArtist(name);
                return {text:part,className:credits.includes(name)?'hmpl-match':key&&credits.some(peer=>normalizeCandidateArtist(peer)===key)?'hmpl-close':'hmpl-mismatch'};
            });
        }
        const ranks=Array(text.length).fill(0); // red, orange, green
        const tokens=str=>[...str.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(m=>({text:m[0],key:m[0].normalize('NFKC').toLowerCase().replace(/’/g,"'"),start:m.index,end:m.index+m[0].length}));
        const left=tokens(text);
        const paint=(start,end,rank)=>{for(let k=start;k<end;k++)ranks[k]=Math.max(ranks[k],rank);};
        for(const peer of peers){
            const rightText=String(peer.value);
            if(text===rightText){paint(0,text.length,2);continue;}
            const equivalent=valuesMatch(type,text,rightText);
            if(equivalent)paint(0,text.length,1);
            const right=tokens(rightText),n=left.length,m=right.length;
            const dp=Array.from({length:n+1},()=>new Uint32Array(m+1));
            for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=left[i].key===right[j].key?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
            const pairs=[];
            for(let i=0,j=0;i<n&&j<m;){if(left[i].key===right[j].key){pairs.push([i++,j++]);}else if(dp[i+1][j]>=dp[i][j+1])i++;else j++;}
            for(let start=0;start<pairs.length;){
                let end=start+1;
                while(end<pairs.length&&pairs[end][0]===pairs[end-1][0]+1&&pairs[end][1]===pairs[end-1][1]+1)end++;
                const group=pairs.slice(start,end);
                if(equivalent||group.some(([i])=>!COMPARISON_EXCLUDED_WORDS.has(left[i].key)&&left[i].key.length>1)){
                    for(let k=0;k<group.length;k++){
                        const [i,j]=group[k],a=left[i],b=right[j];
                        paint(a.start,a.end,a.text===b.text?2:1);
                        if(k){const [pi,pj]=group[k-1];const gap=text.slice(left[pi].end,a.start),peerGap=rightText.slice(right[pj].end,b.start);paint(left[pi].end,a.start,gap===peerGap?2:1);}
                    }
                }
                start=end;
            }
            if(type==='title')for(const token of left)if(['ep','lp','single'].includes(token.key))paint(token.start,token.end,1);
        }
        const parts=[];
        for(let i=0;i<text.length;){let end=i+1;while(end<text.length&&ranks[end]===ranks[i])end++;parts.push({text:text.slice(i,end),className:['hmpl-mismatch','hmpl-close','hmpl-match'][ranks[i]]});i=end;}
        return parts;
    }

    function comparisonClass(type,value,other){
        const peers=comparisonValues(other);
        if(!peers.length)return 'hmpl-unpaired';
        if(peers.some(peer=>String(value)===String(peer.value)))return 'hmpl-match';
        if(type==='date'){
            if(peers.some(peer=>valuesMatch(type,value,peer.value)))return 'hmpl-match';
            const day=comparisonDateDay(value);
            return day!==null&&peers.some(peer=>{const otherDay=comparisonDateDay(peer.value);return otherDay!==null&&Math.abs(day-otherDay)<=DATE_COMPARISON_TOLERANCE_DAYS;})?'hmpl-close':'hmpl-mismatch';
        }
        return peers.some(peer=>valuesMatch(type,value,peer.value))?'hmpl-close':'hmpl-mismatch';
    }

    const DISTRIBUTOR_MAP_CACHE_KEY='hmpl-distributor-map-v1';
    let distributorMap=null;
    const distributorWarningCells=new Map();
    const distributorNameKey=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    function validDistributorMap(data){
        const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
        if(data?.schemaVersion!==1||!object(data.providers)||!object(data.distributors))return false;
        return Object.values(data.distributors).every(item=>item&&typeof item.name==='string'&&Array.isArray(item.aliases)&&item.aliases.every(name=>typeof name==='string')&&object(item.providers)&&
            Object.entries(item.providers).every(([id,value])=>Object.hasOwn(data.providers,id)&&value&&['yes','no','maybe','ended','paused','unknown'].includes(value.status)&&
                (value.evidenceStatus==null||['official','community','third-party','inferred'].includes(value.evidenceStatus))&&
                ['notes','sources','evidenceNotes'].every(key=>value[key]==null||Array.isArray(value[key])&&value[key].every(text=>typeof text==='string'))));
    }
    function distributorDateRange(value){
        const match=String(value||'').match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);if(!match)return null;
        const year=Number(match[1]),month=Number(match[2]||1),day=Number(match[3]||1);
        const start=Date.UTC(year,month-1,day),date=new Date(start);
        if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
        return [start,match[3]?start:match[2]?Date.UTC(year,month,0):Date.UTC(year,11,31)];
    }
    function distributorDateApplies(relationship,date){
        if(!['ended','paused'].includes(relationship.status))return true;
        const release=distributorDateRange(date),start=distributorDateRange(relationship.status==='ended'?relationship.endedAt:relationship.pausedAt);
        // Only warn when the entire possible release-date range is within the unavailable period.
        if(!release||!start||release[0]<start[1])return false;
        if(relationship.status==='paused'&&relationship.resumedAt!=null){
            const end=distributorDateRange(relationship.resumedAt);if(!end||release[1]>=end[0])return false;
        }
        return true;
    }
    function providerCompatibilityWarnings(provider,field,wanted,date){
        if(field!=='distributor'||!distributorMap)return [];
        const keys=comparisonValues(wanted).map(entry=>distributorNameKey(entry.value));
        const matches=Object.entries(distributorMap.distributors).filter(([id,item])=>[id,item.name,...item.aliases].some(name=>keys.includes(distributorNameKey(name))));
        // Ambiguous normalized aliases must not produce an incompatibility claim.
        if(matches.length!==1)return [];
        const item=matches[0][1],relation=item.providers[provider?.id];
        if(!relation||relation.status==='unknown'||!distributorDateApplies(relation,date))return [];
        const notes=[...(relation.notes||[]),...(relation.evidenceNotes||[])];
        if(relation.status==='yes'&&!notes.length)return [];
        const official=relation.evidenceStatus==='official',name=provider.name;
        const message=relation.status==='no'?(relation.evidenceStatus==='inferred'?`${item.name} distribution to ${name} is unconfirmed.`:`${item.name} ${official?'does not':'reportedly does not'} distribute to ${name}.`):
            relation.status==='ended'?`${item.name} ${official?'ended':'reportedly ended'} distribution to ${name} on ${relation.endedAt}.`:
            relation.status==='paused'?`${item.name} distribution to ${name} ${official?'is':'is reportedly'} paused from ${relation.pausedAt}${relation.resumedAt?' until '+relation.resumedAt:''}.`:
            relation.status==='maybe'?`${item.name} distribution to ${name} is conditional or uncertain.`:`${item.name} distribution to ${name}: qualifications apply.`;
        return [{color:official&&['no','ended','paused'].includes(relation.status)?'#f00':'#c77700',
            text:message.replace(/\.$/,'')+', click for details'}];
    }
    function updateDistributorWarning(cell,context){
        cell.querySelector('[data-hmpl-distributor-warning]')?.remove();
        const warning=providerCompatibilityWarnings(context.provider,context.field,context.wanted,context.date)[0];
        if(warning){const icon=comparisonWarningIcon(warning.text,'https://djkhjg.github.io/music-distributor-to-platform-map/distributor-platforms.html');icon.dataset.hmplDistributorWarning='true';icon.style.setProperty('color',warning.color,'important');cell.prepend(icon);}
    }
    async function loadDistributorMap(){
        const cached=await GM_getValue(DISTRIBUTOR_MAP_CACHE_KEY,null);
        const publish=data=>{distributorMap=data;for(const [cell,context]of distributorWarningCells){if(cell.isConnected)updateDistributorWarning(cell,context);else distributorWarningCells.delete(cell);}};
        if(validDistributorMap(cached?.data))publish(cached.data);
        if(distributorMap&&Date.now()-cached.fetchedAt<DISTRIBUTOR_MAP_REFRESH_MS)return;
        const lastAttempt=await GM_getValue(DISTRIBUTOR_MAP_CACHE_KEY+'-attempt',0);
        if(Date.now()-lastAttempt<DISTRIBUTOR_MAP_RETRY_MS)return;
        await GM_setValue(DISTRIBUTOR_MAP_CACHE_KEY+'-attempt',Date.now());
        try{
            const data=await new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'GET',url:DISTRIBUTOR_MAP_URL,anonymous:true,timeout:20000,
                onload:response=>{try{if(response.status!==200)throw new Error('HTTP '+response.status);const data=JSON.parse(response.responseText);if(!validDistributorMap(data))throw new Error('Unsupported distributor dataset');resolve(data);}catch(error){reject(error);}},
                onerror:()=>reject(new Error('Distributor dataset unavailable')),ontimeout:()=>reject(new Error('Distributor dataset timed out'))}));
            await GM_setValue(DISTRIBUTOR_MAP_CACHE_KEY,{data,fetchedAt:Date.now()});publish(data);
        }catch(error){debugWarn('Distributor warnings: retaining last valid dataset',error);}
    }
    function comparisonWarningIcon(explanation,url){
        const note=document.createElement(url?'a':'span');
        if(url){note.href=url;note.target='_blank';note.rel='noopener noreferrer';}
        note.className='hmpl-warning-icon';note.textContent='\u26a0\ufe0e';note.title=explanation;
        note.setAttribute('aria-label',explanation);note.tabIndex=0;
        note.style.setProperty('color','#f00','important');note.style.marginRight='0.3em';note.style.cursor=url?'pointer':'help';
        return note;
    }
    function comparisonValuesCell(input,other,type,active) {
        const cell=comparisonCell('','hmpl-neutral'), entries=comparisonValues(input);
        if(!entries.length)return cell;
        cell.replaceChildren();
        for(const entry of entries){
            const line=document.createElement('div');
            line.className=active ? comparisonClass(type,entry.value,other) : 'hmpl-unpaired';
            const explanation=[entry.assumption===true?'Assumed value':entry.assumption,entry.notifier].filter(Boolean).join('; ');
            if(explanation)line.append(comparisonWarningIcon(explanation));
            if(type==='image')line.append(...comparisonImageCell(entry.value).childNodes);
            else if(active&&['title','text','artist'].includes(type)&&comparisonValues(other).length){
                line.className='';
                for(const part of comparisonTextParts(entry.value,other,type)){const span=document.createElement('span');span.className=part.className;span.textContent=part.text;line.append(span);}
            }else line.append(String(entry.value));
            cell.append(line);
        }
        return cell;
    }

    function getHarmonyComparisonTracks(){
        return [...document.querySelectorAll('table.tracklist')].flatMap((table,disc)=>
            [...table.tBodies].flatMap(body=>[...body.rows]).map((row,index)=>{
                const cells=row.cells;
                const isrcColumn=[...(table.tHead?.rows[0]?.cells||[])].findIndex(cell=>clean(cell.textContent).toUpperCase()==='ISRC');
                const isrc=isrcColumn>=0?injectionPrimaryText(cells[isrcColumn]):'';
                const duration=injectionPrimaryText(cells[3]);
                const parts=duration.split(':').map(Number);
                return {disc:disc+1,isrc,number:injectionPrimaryText(cells[0])||String(index+1),title:injectionPrimaryText(cells[1]),
                    artists:cells[2]?injectionArtistsFromNode(cells[2]):[],length:parts.length>=2&&parts.every(Number.isFinite)?parts.reduce((sum,n)=>sum*60+n,0)*1000:null};
            }));
    }
    function appendTrackComparison(table,label,target,current){
        const wanted=comparisonTracks(target),actual=comparisonTracks(current);
        const toggle=document.createElement('button');toggle.type='button';toggle.className='hmpl-track-toggle';
        const detail=document.createElement('tr');detail.className='hmpl-track-details';
        const cell=document.createElement('td');cell.colSpan=3;
        const list=document.createElement('table');list.className='hmpl-track-table';
        const panel=document.getElementById(PROVIDER_PANEL_ID);
        let expanded=panel?.dataset.tracksExpanded==='true';
        const sync=()=>{detail.hidden=!expanded;toggle.textContent=expanded?'▾':'▸';toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-label',expanded?'Hide tracklist':'Show tracklist');};
        toggle.addEventListener('click',()=>{expanded=!expanded;const host=document.getElementById(PROVIDER_PANEL_ID);if(host)host.dataset.tracksExpanded=String(expanded);sync();});sync();label.append(' ',toggle);
        if(!wanted.length&&!actual.length)cell.textContent='Track details are not available for either release.';
        else{
            const heading=document.createElement('tr');for(const text of ['#','Looking for:','Current:']){const th=document.createElement('th');th.textContent=text;heading.append(th);}list.append(heading);
            for(let i=0;i<Math.max(wanted.length,actual.length);i++){
                const left=wanted[i],right=actual[i],row=document.createElement('tr'),position=document.createElement('th');position.textContent=String(i+1);row.append(position);
                for(const [track,other] of [[left,right],[right,left]]){
                    const td=document.createElement('td');
                    if(!track){td.textContent='[unavailable]';td.className='hmpl-neutral';}
                    else for(const [field,type,value,peer] of [
                        ['Title','title',track.title,other?.title],
                        ['Artist','artist',track.artists?.map(a=>a.name||a).join(', '),other?.artists?.map(a=>a.name||a).join(', ')],
                        ['Length','duration',track.length?injectionDuration(track.length):'',other?.length?injectionDuration(other.length):''],
                        ['ISRC','isrc',track.isrc,other?.isrc]]){
                        if(!value&&!peer&&field!=='Title')continue;
                        const line=document.createElement('div');line.title=field;
                        const shown=track.comparisonValues?.[field.toLowerCase()]||value;
                        const rendered=comparisonValuesCell(shown,peer,type,Boolean(other));
                        if(field==='Length' && other){
                            for(const item of rendered.children)item.className=trackLengthComparison(track.length,other.length);
                        }
                        line.className=rendered.className;line.append(...rendered.childNodes);td.append(line);
                    }
                    row.append(td);
                }list.append(row);
            }cell.append(list);
        }
        // Derive the summary from the rendered field comparisons so tolerance
        // and any future field rules cannot disagree with the expanded view.
        if(list.querySelector('.hmpl-mismatch')){
            expanded=true;sync();
            const summary=label.parentElement;
            for(const countCell of [...summary.cells].slice(1)){
                for(const value of countCell.querySelectorAll('.hmpl-match,.hmpl-close,.hmpl-mismatch'))value.className='hmpl-mismatch';
                const note=document.createElement('span');note.className='hmpl-warning-icon';note.textContent='\u26a0\ufe0e';
                note.title='Track information may not match. Expand the tracklist to compare details.';
                note.setAttribute('aria-label',note.title);note.tabIndex=0;
                note.style.setProperty('color','#f00','important');note.style.marginRight='0.3em';note.style.cursor='help';
                (countCell.firstElementChild||countCell).prepend(note);
            }
        }
        if(!list.querySelector('.hmpl-mismatch')&&list.querySelector('.hmpl-close'))for(const value of label.parentElement.querySelectorAll('td .hmpl-match'))value.className='hmpl-close';
        detail.append(cell);table.append(detail);
    }

    function buildComparisonTable(
        target,
        current,
        provider = null
    ) {
        const table =
            document.createElement(
                'table'
            );

        table.className =
            'hmpl-comparison-table';

        const header =
            document.createElement(
                'tr'
            );

        const blank =
            document.createElement(
                'th'
            );

        blank.className =
            'hmpl-comparison-label';

        const wantedHeading =
            document.createElement(
                'th'
            );

        wantedHeading.textContent =
            'Looking for:';

        const currentHeading =
            document.createElement(
                'th'
            );

        currentHeading.textContent =
            'Current:';

        header.append(
            blank,
            wantedHeading,
            currentHeading
        );

        table.append(
            header
        );

        /*
         * All external providers normalize their releases to this
         * same six-field shape.
         */

        const rows = [
            {
                label:
                    'Cover',

                type:
                    'image',

                wanted:
                    target?.coverArt,

                current:
                    current?.coverArt
            },

            {
                label:
                    'Title',

                type:
                    'title',

                wanted:
                    target?.title,

                current:
                    current?.title
            },

            {
                label:
                    'Artist',

                type:
                    'artist',

                wanted:
                    target?.artists?.map(artist=>artist.name || artist).join(', '),

                current:
                    current?.artists?.map(artist=>artist.name || artist).join(', ')
            },

            {
                label:
                    'GTIN',

                type:
                    'gtin',

                wanted:
                    target?.gtin,

                current:
                    current?.gtin
            },

            {
                label:
                    'Tracks',

                type:
                    'tracks',

                wanted:
                    target?.trackCount,

                current:
                    current?.trackCount ?? current?.tracks?.length
            },

            {
                label:
                    'Date',

                type:
                    'date',

                wanted:
                    target?.date,

                current:
                    current?.date
            },

            {
                label:
                    'Label',

                type:
                    'text',

                wanted:
                    target?.label,

                current:
                    current?.label || current?.labels?.map(label=>label.name || label).join(', ')
            }
        ];

        rows.push({label:'Distributor',type:'text',wanted:target?.distributor,current:current?.distributor||current?.firstTrackMetadata?.distributor});
        rows.push(rows.splice(rows.findIndex(row=>row.label==='Tracks'),1)[0]);
        const fields={Cover:'coverArt',Title:'title',Artist:'artists',GTIN:'gtin',Tracks:'trackCount',Date:'date',Label:'label',Distributor:'distributor'};
        const currentValues={...current?.comparisonValues,...provider?.getComparisonValues?.(current)};
        for (const item of rows) {
            const field=fields[item.label];
            if(field && Object.hasOwn(target?.comparisonValues || {},field))item.wanted=target.comparisonValues[field];
            if(field && Object.hasOwn(currentValues,field))item.current=currentValues[field];
            const row =
                document.createElement(
                    'tr'
                );

            const label =
                document.createElement(
                    'th'
                );

            label.className =
                'hmpl-comparison-label';

            label.textContent =
                item.label;

            if(item.type==='image')row.classList.add('hmpl-cover-row');

            row.append(
                label,
                comparisonValuesCell(
                    item.wanted,
                    item.current,item.type,Boolean(current)
                ),
                comparisonValuesCell(
                    item.current,
                    item.wanted,item.type,Boolean(current)
                )
            );

            if(field==='distributor'){
                for(const cell of distributorWarningCells.keys())if(!cell.isConnected)distributorWarningCells.delete(cell);
                const context={provider,field,wanted:item.wanted,date:target?.date};
                distributorWarningCells.set(row.lastElementChild,context);updateDistributorWarning(row.lastElementChild,context);
            }

            if(item.type==='image'){
                const left=comparisonValues(item.wanted)[0]?.value,right=comparisonValues(item.current)[0]?.value;
                for(const image of row.querySelectorAll('img')){
                    image.style.cursor='zoom-in';image.tabIndex=0;image.setAttribute('role','button');image.setAttribute('aria-label','Compare cover artwork');
                    image.addEventListener('click',()=>showCoverComparison(left,right));
                    image.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showCoverComparison(left,right);}});
                }
            }
            table.append(row);
            if(item.label==='Tracks')appendTrackComparison(table,label,target,current);
        }

        return table;
    }

    function renderProviderPanel({
        provider,
        target,
        current = null,
        state = '',
        message = '',
        actions = [],
        loading = false,
        warning = false,
        candidateNavigation = null
    }) {
        if (
            !provider ||
            !target
        ) {
            return;
        }

        injectProviderPanelStyles();

        let panel =
            $(
                `#${PROVIDER_PANEL_ID}`
            );

        if (!panel) {
            panel =
                document.createElement(
                    'div'
                );

            panel.id =
                PROVIDER_PANEL_ID;

            (
                document.body ||
                document.documentElement
            ).append(
                panel
            );
        }

        panel.dataset.loading=String(loading);

        const title =
            document.createElement(
                'div'
            );

        title.className =
            'hmpl-panel-title';

        panel.style.setProperty('--hmpl-provider-color',provider.presentation?.backgroundColor || '#333');
        const logo=document.createElement('span');logo.className='hmpl-panel-logo';logo.setAttribute('aria-hidden','true');
        if(provider.presentation?.icon)logo.append(createProviderSvg(provider.presentation.icon));
        const heading=document.createElement('div');heading.className='hmpl-panel-heading';
        for(const text of ['Harmony: More Provider Lookups',provider.name]){const line=document.createElement('span');line.textContent=text;heading.append(line);}
        const toggle=document.createElement('button');toggle.type='button';toggle.className='hmpl-panel-toggle';
        const sync=()=>{const collapsed=panel.dataset.collapsed==='true';toggle.textContent=collapsed?'⌃':'⌄';toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-label',collapsed?'Expand comparison':'Collapse comparison');};
        toggle.addEventListener('click',()=>{panel.dataset.collapsed=String(panel.dataset.collapsed!=='true');sync();});sync();title.append(logo,heading,toggle);
        const headerStatus=document.createElement('div');headerStatus.className='hmpl-header-status';headerStatus.textContent=state;heading.append(headerStatus);

        const stateElement =
            document.createElement(
                'div'
            );

        stateElement.className =
            'hmpl-panel-state';

        stateElement.textContent =
            state;

        if(candidateNavigation?.count>1){
            const nav=candidateNavigation;
            stateElement.style.cssText='display:flex;align-items:center;gap:10px';
            const label=document.createElement('span');label.textContent=state+' ';
            const count=document.createElement('span');count.textContent=(nav.index+1)+'/'+nav.count;count.style.color='red';label.append(count);label.style.flex='1';
            const arrow=(text,name,click)=>{const button=document.createElement('button');button.type='button';button.textContent=text;button.setAttribute('aria-label',name);button.disabled=nav.disabled;button.style.cssText='background:transparent;color:var(--hmpl-provider-color);font-size:30px;padding:0 5px;min-height:32px;text-shadow:none';button.addEventListener('click',click);return button;};
            stateElement.replaceChildren(arrow('⇦','Previous candidate',nav.previous),label,arrow('⇨','Next candidate',nav.next));
        }

        const comparisonTable =
            buildComparisonTable(
                target,
                current,
                provider
            );

        const messageElement =
            document.createElement(
                'div'
            );

        messageElement.className =
            'hmpl-panel-message';

        messageElement.textContent =
            message;

        const actionContainer =
            document.createElement(
                'div'
            );

        actionContainer.className =
            'hmpl-panel-actions';

        for (
            const action
            of actions
        ) {
            if (
                action.hidden
            ) {
                continue;
            }

            const button =
                document.createElement(
                    'button'
                );

            button.type =
                'button';

            button.textContent =
                action.label;
            button.disabled=Boolean(action.disabled);
            button.setAttribute('aria-disabled',String(button.disabled));

            if (
                action.title
            ) {
                button.title =
                    action.title;
            }

            button.addEventListener(
                'click',
                action.onClick
            );

            actionContainer.append(
                button
            );
        }

        if(warning){stateElement.style.cssText='color:#a33b00;background:#fff1db;border:1px solid #d77a00;padding:8px';stateElement.setAttribute('role','alert');}
        const body=document.createElement('div');body.className='hmpl-panel-body';body.append(stateElement,comparisonTable);panel.replaceChildren(title,body);

        if (message) {
            body.append(
                messageElement
            );
        }

        if (
            actionContainer
                .childElementCount
        ) {
            body.append(
                actionContainer
            );
        }
    }

    function getDefaultProviderStateInfo(
        provider,
        session
    ) {
        if(session.state==='resolving'&&provider.isBlockedPage?.())return {warning:true,state:'CAPTCHA detected — manual verification required',message:'Complete the CAPTCHA on this page to continue, or skip this provider.'};
        if (session.state === 'resolving' && session.want === 'full-release' && session.current && !fullReleaseIsComplete(session.current)) {
            return {state: 'Release data is incomplete.', message: 'The exact release title, artist credit and complete tracklist are needed before this release can be used. A GTIN is not required.'};
        }
        if (
            session.state ===
            'skipped'
        ) {
            return {
                state:
                    `${provider.name} skipped.`,

                message:
                    `${provider.name} was skipped for this release.`
            };
        }

        if (
            session.state ===
            'found'
        ) {
            return {
                state:
                    'Matching release found.',

                message:
                    `The ${provider.name} release has been identified.`
            };
        }

        if (
            session.phase ===
            'checking'
        ) {
            return {
                state:
                    `Checking this ${provider.name} release…`,

                message:
                    provider.requireUserConfirmation
                        ? 'Review the comparison, then choose “Use this release” to return the full release to Harmony.'
                        : 'Comparing the current release with the Harmony lookup.'
            };
        }

        if (
            session.phase ===
            'manual'
        ) {
            return {
                state:
                    'No automatic match found.',

                message:
                    `Browse ${provider.name} for the correct release, or skip this provider.`
            };
        }

        if (provider.isReleasePage?.()) {
            return { state: `${provider.name} release page opened.`, message: 'Comparing this release with Harmony.' };
        }
        if (provider.isSearchPage?.()) {
            return { state: `Searching ${provider.name}.`, message: 'Looking for a matching release.' };
        }
        return {
            state:
                `${provider.name} lookup active.`,

            message:
                `Browse ${provider.name} for the correct release, or skip this provider.`
        };
    }

    function renderResolverPanel(
        provider,
        session
    ) {
        if (!session) {
            return;
        }

        const stateInfo =
            getDefaultProviderStateInfo(
                provider,
                session
            );

        debugTrace('Core -> helper UI: rendering comparison and actions', session, { hasCurrent: Boolean(session.current) });
        const current =
            session.current;

        const actions = [];

        /*
         * Providers decide whether the current release may be manually
         * accepted. The generic core owns the actual acceptance behavior.
         */
        {
            actions.push({
                label:
                    'Use this release',
                disabled:!canManuallyResolve(provider,session,current),
                title:manualAcceptanceReason(provider,session,current),

                onClick:
                    async () => {
                        const latest =
                            await getResolverRequest(
                                provider, session.id
                            );

                        if (!latest || latest.id !== session.id || latest.state !== 'resolving') {
                            return;
                        }

                        const latestCurrent =
                            provider.getCurrentRelease?.();

                        if (!latestCurrent) {
                            return;
                        }

                        debugInfo(
                            '[Harmony: More Provider Lookups]',
                            `Using current ${provider.name} release.`,
                            latestCurrent
                        );

                        await acceptProviderRelease(
                            provider,
                            latest,
                            latestCurrent
                        );
                    }
            });
        }

        if (
            session.state !==
            'skipped' &&
            session.state !==
            'found'
        ) {
            actions.push({
                label:
                    `Skip ${provider.name}`,

                onClick:
                    async () => {
                        const latest =
                            await getResolverRequest(
                                provider, session.id
                            );

                        if (!latest || latest.id !== session.id || latest.state !== 'resolving') {
                            return;
                        }

                        await skipProviderLookup(
                            provider,
                            latest
                        );
                    }
            });
        }

        renderProviderPanel({
            provider,
            target:
                session.target,
            current,
            state:
                stateInfo.state,
            message:
                stateInfo.message,
            warning:stateInfo.warning,
            actions
        });
    }

    // =========================================================================
    // BANDCAMP PROVIDER — website detection, scraping and capabilities
    // =========================================================================

    const isBandcamp = () =>
        location.hostname ===
        'bandcamp.com' ||
        location.hostname.endsWith(
            '.bandcamp.com'
        );

    const isBandcampSearch = () =>
        location.hostname ===
        'bandcamp.com' &&
        location.pathname ===
        '/search';

    const isBandcampRelease = () =>
        location.hostname
            .endsWith(
                '.bandcamp.com'
            ) &&
        /^\/(?:album|track)\//i
            .test(
                location.pathname
            );


    // =========================================================================
    // Bandcamp: website data adapter
    // =========================================================================

    function normalizeBandcampSearchText(value) {
        return String(value ?? '')
            .normalize('NFKC')
            .replace(/[’‘]/g, "'")
            .replace(
                /[^a-zA-Z0-9'\s]/g,
                ' '
            )
            .replace(
                /\s+/g,
                ' '
            )
            .trim();
    }

    function buildBandcampSearchUrl(context) {
        const query =
            normalizeBandcampSearchText(
                [
                    ...context.artists,
                    stripReleaseTypeSuffix(
                        context.title
                    )
                ].join(' ')
            );

        const url =
            new URL(
                'https://bandcamp.com/search'
            );

        url.searchParams.set(
            'q',
            query
        );

        /*
         * Bandcamp represents single-track releases as tracks instead
         * of albums.
         */
        if (
            context.trackCount === 1
        ) {
            url.searchParams.set(
                'item_type',
                't'
            );
        } else {
            url.searchParams.set(
                'item_type',
                'a'
            );
        }

        return url.href;
    }

    function matchesBandcampReleaseUrl(url) {
        try {
            const parsed =
                url instanceof URL
                    ? url
                    : new URL(url);

            return (
                parsed.hostname
                    .toLowerCase()
                    .endsWith(
                        '.bandcamp.com'
                    ) &&
                /^\/(?:album|track)\//i
                    .test(
                        parsed.pathname
                    )
            );
        } catch {
            return false;
        }
    }

    function parseBandcampEmbeddedJson(
        attributeName, doc=document
    ) {
        const element =
            doc.querySelector(
                `[data-${attributeName}]`
            );

        if (!element) {
            return null;
        }

        const raw =
            element.getAttribute(
                `data-${attributeName}`
            );

        if (!raw) {
            return null;
        }

        try {
            return JSON.parse(
                raw
            );
        } catch (error) {
            debugWarn(
                '[Harmony: More Provider Lookups]',
                `Could not parse Bandcamp data-${attributeName}.`,
                error
            );

            return null;
        }
    }

    function getBandcampRealTrackCount(
        tralbum, doc=document
    ) {
        const description =
            doc.querySelector(
                'meta[property="og:description"]'
            )
                ?.content || '';

        const descriptionMatch =
            description.match(
                /(\d+)\s+track/i
            );

        if (descriptionMatch) {
            return Number(
                descriptionMatch[1]
            );
        }

        return Array.isArray(
            tralbum?.trackinfo
        )
            ? tralbum.trackinfo.length
            : 0;
    }

    function bandcampComparisonTrackCount(tralbum,doc=document) {
        const total=getBandcampRealTrackCount(tralbum,doc);
        const rows=[...doc.querySelectorAll('.track_row_view')].filter(row=>!row.hidden);
        // A missing preview is not a hidden track. Compare the advertised total
        // with the listed tracks; fall back to trackinfo when rows are unavailable.
        const listed=rows.length || (Array.isArray(tralbum.trackinfo)?tralbum.trackinfo.length:null);
        const hidden=listed==null?0:Math.max(0,total-listed);
        return {value:total,...(hidden?{notifier:hidden+' tracks hidden'}:{})};
    }

    function getCurrentBandcampRelease(doc=document,pageUrl=location.href) {
        if (
            !matchesBandcampReleaseUrl(pageUrl)
        ) {
            return null;
        }

        const tralbum =
            parseBandcampEmbeddedJson(
                'tralbum',doc
            );

        if (!tralbum) {
            return null;
        }

        const band =
            parseBandcampEmbeddedJson(
                'band',doc
            );

        const coverArt =
            clean(
                doc.querySelector(
                    'meta[property="og:image"]'
                )
                    ?.content
            );

        const tracks=(tralbum.trackinfo||[]).map((track,index)=>({
            url:track.title_link?new URL(track.title_link,pageUrl).href:'',
            number:String(track.track_num||index+1),title:clean(track.title),
            artists:[clean(track.artist||tralbum.artist||tralbum.current?.artist||band?.name)].filter(Boolean),
            length:Number.isFinite(track.duration)?Math.round(track.duration*1000):null
        }));
        const trackCount=getBandcampRealTrackCount(tralbum,doc);
        return {
            title:
                clean(
                    tralbum.current?.title
                ),

            artists: [clean(
                    tralbum.artist ||
                    tralbum.current?.artist ||
                    band?.name
                )].filter(Boolean),

            gtin:
                clean(
                    tralbum.current?.upc
                ),

            tracks,trackCount,
            tracklistComplete:trackCount>0&&tracks.length===trackCount&&tracks.every(track=>track.title&&track.artists.length&&track.length>0),

            date:
                normalizeDate(
                    tralbum.current?.release_date
                ),

            comparisonValues: {trackCount:bandcampComparisonTrackCount(tralbum,doc),date: [
                ['new_date','date created'],
                ['release_date','official release date'],
                ['publish_date','date page was published on Bandcamp'],
                ['mod_date','date page was last edited']
            ].map(([field,notifier]) => ({value: normalizeDate(tralbum.current?.[field]),notifier:field+': '+notifier})).filter(item=>item.value)},

            /*
             * No dependable Bandcamp label field is currently used.
             */
            label:
                '',

            coverArt,

            url:
                getBandcampReleaseKey(pageUrl)
        };
    }



    // =========================================================================
    // Bandcamp: passive page observations (no background fetches or crawling)
    // =========================================================================

    function getBandcampSearchResults(doc=document) {
        return [...doc.querySelectorAll('.searchresult')].map(result => {
            const link = [...result.querySelectorAll('a[href]')].find(item => matchesBandcampReleaseUrl(item.href));
            if (!link) return null;
            const title = clean(result.querySelector('.heading')?.textContent || link.textContent);
            const byline = clean(result.querySelector('.subhead')?.textContent);
            const artist = /^by\s+/i.test(byline) ? byline.replace(/^by\s+/i, '') : '';
            let identity={};try{identity=JSON.parse(result.getAttribute('data-search')||'{}');}catch{}
            const trackCount=Number(clean(result.querySelector('.length')?.textContent).match(/(\d+)\s+tracks?/i)?.[1])||null;
            return title ? {title,artists:artist?[artist]:[],url:getBandcampReleaseKey(link.href),
                bandcampId:identity.id,itemType:identity.type,trackCount,
                date:normalizeDate(clean(result.querySelector('.released')?.textContent).replace(/^released\s+/i,'')),
                coverArt:result.querySelector('.art img')?.getAttribute('src')||''} : null;
        }).filter(Boolean);
    }

    function getBandcampMusicCards() {
        const band = parseBandcampEmbeddedJson('band');
        return $$('#music-grid .music-grid-item').map(card => {
            const link = [...card.querySelectorAll('a[href]')].find(item => matchesBandcampReleaseUrl(item.href));
            if (!link) return null;
            const titleElement = card.querySelector('.title');
            const titleClone = titleElement?.cloneNode(true);
            titleClone?.querySelectorAll('.artist').forEach(item => item.remove());
            const title = clean(titleClone?.textContent);
            const artist = clean(card.querySelector('.artist')?.textContent).replace(/^by\s+/i, '') ||
                (band && !band.is_label ? clean(band.name) : '');
            return title ? { title, artists: artist ? [artist] : [], url: getBandcampReleaseKey(link.href) } : null;
        }).filter(Boolean);
    }

    function observeBandcampPage(emit) {
        const seen = new Set();
        let lastPage = '';
        let lastEmptyState = '';
        let wasReady = false;
        let timer = null;
        function scan() {
            timer = null;
            const pageUrl = location.origin + location.pathname + location.search;
            if (pageUrl !== lastPage) { seen.clear(); lastEmptyState = ''; wasReady = false; lastPage = pageUrl; }
            const kind = isBandcampSearch() ? 'search' : isBandcampRelease() ? 'release' : 'listing';
            const level = kind === 'release' ? 2 : 1;
            const current = kind === 'release' ? getCurrentBandcampRelease() : null;
            const records = kind === 'release' ? (current ? [current] : []) :
                kind === 'search' ? getBandcampSearchResults() : getBandcampMusicCards();
            const fresh = records.filter(record => {
                const signature = JSON.stringify(record);
                if (seen.has(signature)) return false;
                seen.add(signature);
                return true;
            });
            const ready = document.readyState !== 'loading';
            // Emit one ready/empty notification too, so active lookups can enter
            // manual mode or recover from an unavailable cached URL.
            const emptyState = kind + ':' + ready;
            if (fresh.length || (ready && !wasReady) || (ready && !records.length && lastEmptyState !== emptyState)) {
                lastEmptyState = emptyState;
                emit({ kind, level, records: ready && !wasReady ? records : fresh, ready });
            }
            wasReady = ready;
        }
        function schedule(mutations = []) {
            if (mutations.length && mutations.every(item => item.target.nodeType === 1 &&
                item.target.closest?.('#hmpl-provider-panel'))) return;
            if (timer === null) timer = setTimeout(scan, 150);
        }
        const observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['data-tralbum', 'data-band', 'href'] });
        document.addEventListener('DOMContentLoaded', scan, { once: true });
        window.addEventListener('pageshow', schedule);
        window.addEventListener('pagehide', () => { if (timer !== null) clearTimeout(timer); timer = null; });
        scan();
    }


    function getBandcampReleaseKey(value) {
        const url = new URL(value);
        return url.origin + url.pathname.replace(/\/+$/, '');
    }

    function canManuallyAcceptBandcampRelease(
        current
    ) {
        return Boolean(
            current &&
            PROVIDERS.bandcamp.matchesReleaseUrl(current.url) &&
            !normalizeComparisonGtin(
                current.gtin
            )
        );
    }

    // =========================================================================
    // Bandcamp: provider registration
    // =========================================================================

    function bandcampDocument(url,signal){
        const parsed=new URL(url);
        if(parsed.protocol!=='https:' || !(parsed.hostname==='bandcamp.com'||parsed.hostname.endsWith('.bandcamp.com')))return Promise.reject(new Error('Invalid Bandcamp destination'));
        return new Promise((resolve,reject)=>providerHttp(signal,{method:'GET',url,timeout:25000,
            onload:response=>{try{
                const final=new URL(response.finalUrl||url);
                if(response.status!==200 || !(final.hostname==='bandcamp.com'||final.hostname.endsWith('.bandcamp.com')))throw new Error('Bandcamp response requires interaction');
                resolve(new DOMParser().parseFromString(response.responseText,'text/html'));
            }catch(error){reject(error);}},onerror:()=>reject(new Error('Bandcamp request failed')),ontimeout:()=>reject(new Error('Bandcamp request timed out'))}));
    }
    async function bandcampBackgroundSearch({target,observe,signal}){
        const provider=PROVIDERS.bandcamp;
        if(target.url&&provider.matchesReleaseUrl(target.url))return {status:'candidate',record:{url:getBandcampReleaseKey(target.url),level:1}};
        const url=provider.buildSearchUrl(target);
        try{
            const doc=await bandcampDocument(url,signal),records=getBandcampSearchResults(doc);
            await observeProviderBatch(observe,1,records);
            const candidate=records.find(record=>classifyProviderMatch(provider,target,normalizeProviderObservation(provider,1,record)));
            debugTrace('Bandcamp: background candidates evaluated',null,{results:records.length,candidate:candidate?.url});
            return candidate?{status:'candidate',record:{...candidate,level:1}}:{status:'no-match'};
        }catch(error){debugWarn('Bandcamp background search unavailable',error);return {status:'interaction-required',url,reason:'search-unavailable'};}
    }
    async function bandcampBackgroundEnrich({record,signal}){
        const url=getBandcampReleaseKey(record.url);
        try{
            const doc=await bandcampDocument(url,signal),release=getCurrentBandcampRelease(doc,url);
            if(!release?.title||!release.artists?.length)throw new Error('Bandcamp release metadata unavailable');
            return {status:'candidate',record:{...release,level:2}};
        }catch(error){debugWarn('Bandcamp background enrichment unavailable',error);return {status:'interaction-required',url,reason:'enrichment-unavailable'};}
    }

    PROVIDERS.bandcamp = {
        releaseActions:{types:{artist:[['bandcamp',718]],label:[['bandcamp',719]],recording:[['free streaming',268]]},
            identity:(value,type)=>{try{const url=new URL(value);if(!/^[^.]+\.bandcamp\.com$/.test(url.hostname))return '';const path=url.pathname.replace(/\/$/,'');return (type==='recording'?/^\/track\/[^/]+$/.test(path):path==='')?url.hostname+path:'';}catch{return '';}}},
        presentation:{backgroundColor:'#629aa9',icon: {"tag":"svg","attrs":{"viewBox":"0 0 40 40"},"children":[{"tag":"path","attrs":{"fill":"currentColor","d":"M4 29 15 11h21L25 29z"}}]}},
        lookupInputs:{gtinCache:true},
        id: 'bandcamp',
        name: 'Bandcamp',
        harmony: { native: true, want: 'provider-url' },
        isCurrentSite: isBandcamp,
        isSearchPage: isBandcampSearch,
        isReleasePage: isBandcampRelease,
        buildSearchUrl: buildBandcampSearchUrl,
        backgroundSearch:bandcampBackgroundSearch,backgroundEnrich:bandcampBackgroundEnrich,
        matchesReleaseUrl: matchesBandcampReleaseUrl,
        getReleaseKey: getBandcampReleaseKey,
        getSearchResults: getBandcampSearchResults,
        observePage: observeBandcampPage,
        requireUserConfirmation: false,
        getCurrentRelease: getCurrentBandcampRelease,
        canManuallyAccept: canManuallyAcceptBandcampRelease,

    };

    // =========================================================================
    // TRAXSOURCE MODULE — identity discovery, playlist acquisition and matching
    // =========================================================================

    const TRAXSOURCE_ORIGIN = 'https://www.traxsource.com';
    const TRAXSOURCE_BATCH_LIMIT = 50; // One request per document; excess IDs wait for another visit.
    let traxsourceCurrentRelease = null;

    function traxsourceReleaseKey(url) {
        try { const parsed = new URL(url, TRAXSOURCE_ORIGIN);
            return /^(www\.)?traxsource\.com$/.test(parsed.hostname) && parsed.protocol === 'https:'
                ? parsed.pathname.match(/^\/title\/(\d+)(?:\/|$)/)?.[1] || '' : '';
        } catch { return ''; }
    }

    function traxsourceSearchUrl(target) {
        const normalize = value => clean(value?.name || value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const artist = (target.artists || []).map(normalize).filter(Boolean).join(' ');
        const title = normalize(target.title);
        const term = artist && title ? artist + '\\|' + title : title || artist || clean(target.gtin);
        return TRAXSOURCE_ORIGIN + '/search/titles?' + new URLSearchParams({term});
    }

    function traxsourceArtists(node) {
        if (!node) return [];
        const links = [...node.querySelectorAll('a[href*="/artist/"]')];
        if (links.length) return links.map(a => ({name: clean(a.textContent), id: a.getAttribute('href').match(/\/artist\/(\d+)/)?.[1], url: new URL(a.getAttribute('href'), TRAXSOURCE_ORIGIN).href}));
        // Preserve the exact display credit; never invent artists from track credits.
        const name = clean(node.textContent);
        return name ? [{name}] : [];
    }

    function discoverTraxsourceReleases(doc=document,pageUrl=location.href) {
        const identities = new Map();
        const current = doc.querySelector('#ttlPageCont[data-tid]');
        const add = (id, value = {}) => {
            if (!/^\d+$/.test(id || '')) return;
            identities.set(id, {...identities.get(id), id, key: id, url: TRAXSOURCE_ORIGIN + '/title/' + id, ...value});
        };
        // Current release goes first so the conservative batch cap cannot omit it.
        if (current) {
            const id = current.dataset.tid;
            const expected = current.querySelector('.com-play-all[data-tracks]')?.dataset.tracks.split(',').filter(Boolean);
            const label = current.querySelector('.page-head .com-label');
            const catalogNumber = clean(current.querySelector('.cat-rdate')?.textContent).split('|')[0].trim();
            add(id, {title: clean(current.querySelector('.page-head .title')?.textContent), artists: traxsourceArtists(current.querySelector('.page-head .artists')), expectedTrackIds: expected,
                labels: label ? [{name: clean(label.textContent), id: label.getAttribute('href').match(/\/label\/(\d+)/)?.[1], catalogNumber}] : [],
                catalogNumber, coverArt: current.querySelector('.t-image img')?.src || '',
                url: traxsourceReleaseKey(pageUrl) === id ? pageUrl.split('#')[0] : TRAXSOURCE_ORIGIN + '/title/' + id});
        }
        for (const card of doc.querySelectorAll('.grid-item.play-ttl[data-tid]')) {
            const title = card.querySelector('.com-title');
            const links = card.querySelector('.links');
            if (!title || !links || identities.get(card.dataset.tid)?.title) continue;
            const credit = links.cloneNode(true);
            credit.querySelectorAll('.com-title,.com-label').forEach(node => node.remove());
            const label = card.querySelector('.com-label');
            add(card.dataset.tid, {title: clean(title.textContent), artists: traxsourceArtists(credit),
                cardLabel: label ? {name: clean(label.textContent), id: label.getAttribute('href').match(/\/label\/(\d+)/)?.[1]} : null,
                cardArtwork: card.querySelector('.grid-image img')?.src || '',
                url: new URL(title.getAttribute('href'), TRAXSOURCE_ORIGIN).href});
        }
        for (const row of doc.querySelectorAll('.trk-row.play-trk[data-trid]')) {
            const id = row.querySelector('[data-cart]')?.getAttribute('data-cart').match(/\btitle_id\s*:\s*["']?(\d+)/)?.[1];
            if (id && !identities.has(id)) add(id);
        }
        return {identities, currentId: current?.dataset.tid || ''};
    }

    // Restricted data grammar, not eval: reject executable expressions and unsafe keys.
    function parseTraxsourcePlaylist(xml) {
        const source = xml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1];
        if (!source) throw new Error('Traxsource playlist did not contain CDATA.');
        let at = 0;
        const whitespace = () => { while (/\s/.test(source[at] || '') && at < source.length) at++; };
        const string = () => {
            const quote = source[at++]; let result = '';
            while (at < source.length) {
                let char = source[at++];
                if (char === quote) return result;
                if (char === '\\') {
                    char = source[at++];
                    if (char === 'u' || char === 'x') {
                        const length = char === 'u' ? 4 : 2, hex = source.slice(at, at + length);
                        if (!new RegExp('^[0-9a-fA-F]{' + length + '}$').test(hex)) throw new Error('Invalid string escape');
                        result += String.fromCharCode(parseInt(hex, 16)); at += length;
                    } else if (['n','r','t','b','f','v'].includes(char)) result += {n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v'}[char];
                    else if (['\\','"',"'",'/'].includes(char)) result += char;
                    else throw new Error('Unsupported string escape');
                } else result += char;
            }
            throw new Error('Unterminated playlist string');
        };
        function value(depth = 0) {
            if (depth > 30) throw new Error('Playlist nesting limit');
            whitespace(); const char = source[at];
            if (char === '"' || char === "'") return string();
            if (char === '[' || char === '{') {
                const array = char === '[', end = array ? ']' : '}', result = array ? [] : {};
                at++; whitespace();
                while (source[at] !== end) {
                    if (array) result.push(value(depth + 1));
                    else {
                        whitespace(); let key;
                        if (source[at] === '"' || source[at] === "'") key = string();
                        else { key = source.slice(at).match(/^[A-Za-z_$][\w$]*/)?.[0]; if (!key) throw new Error('Invalid playlist key'); at += key.length; }
                        if (['__proto__','constructor','prototype'].includes(key)) throw new Error('Unsafe playlist key');
                        whitespace(); if (source[at++] !== ':') throw new Error('Expected colon');
                        result[key] = value(depth + 1);
                    }
                    whitespace(); if (source[at] === end) break;
                    if (source[at++] !== ',') throw new Error('Expected comma'); whitespace();
                }
                at++; return result;
            }
            const token = source.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
            if (!token) throw new Error('Unsupported playlist expression');
            at += token.length; return JSON.parse(token);
        }
        const result = value(); whitespace();
        if (at !== source.length || !Array.isArray(result) || result.some(track => !track || Array.isArray(track) || typeof track !== 'object')) throw new Error('Invalid playlist array');
        return result;
    }

    function traxsourcePossibleGtin(value) {
        const digits = clean(value);
        if (!/^\d{12,14}$/.test(digits)) return '';
        let sum = 0;
        for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(digits[i]) * weight;
        return (10 - sum % 10) % 10 === Number(digits.at(-1)) ? digits : '';
    }

    function traxsourcePlaylistRecords(tracks, requestedIds) {
        const groups = new Map(), requested = new Set(requestedIds);
        for (const track of tracks) {
            const id = String(track.title_id);
            if (!requested.has(id)) continue;
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(track);
        }
        const records = new Map();
        for (const [id, group] of groups) {
            const first = group[0];
            const normalized = group.map((track, index) => ({
                id: String(track.track_id), number: String(index + 1), title: clean(track.title),
                artists: (track.artist || []).map(artist => ({id: String(artist[0]), name: clean(artist[2]), slug: artist[3]})),
                url: injectionUrl(new URL(track.track_url || '/track/' + track.track_id, TRAXSOURCE_ORIGIN).href),
                length: /^\d+:\d{2}(?::\d{2})?$/.test(track.duration || '') ? track.duration.split(':').reduce((n, part) => n * 60 + Number(part), 0) * 1000 : null,
                genre: {name: track.genre, id: track.genre_url?.match(/\/genre\/(\d+)/)?.[1]}, bpm: track.bpm, key: track.keysig,
                audioOriginCode: track.ai_badge?.match(/data-ais=["'](\d+)/)?.[1] || null
            }));
            const complete = normalized.every(track => /^\d+$/.test(track.id) && track.title && track.artists.length) && new Set(normalized.map(track => track.id)).size === normalized.length;
            records.set(id, {id, key: id, url: TRAXSOURCE_ORIGIN + (first.title_url || '/title/' + id),
                title: '', artists: [], catalogNumber: clean(first.catnumber), possibleGTIN: traxsourcePossibleGtin(first.catnumber),
                labels: first.label ? [{id: String(first.label[0]), name: clean(first.label[1]), catalogNumber: clean(first.catnumber)}] : [],
                date: first.r_date, coverArt: first.image, tracks: normalized, tracklistComplete: complete,
                completeness: {trackMetadata: complete, releaseIdentity: false},
                externalLinks: [{url: TRAXSOURCE_ORIGIN + (first.title_url || '/title/' + id), types: ['paid download']}]
            });
        }
        return records;
    }

    function fetchTraxsourcePlaylist(ids,signal) {
        return new Promise((resolve, reject) => providerHttp(signal,{
            method: 'GET', url: 'https://w-static.traxsource.com/scripts/playlist.php?' + new URLSearchParams({titles: ids.join(',')}),
            anonymous: true, timeout: 20000,
            onload: response => {
                if (response.status !== 200) return reject(new Error('Traxsource playlist HTTP ' + response.status + '; no automatic retry.'));
                try { resolve(traxsourcePlaylistRecords(parseTraxsourcePlaylist(response.responseText), ids)); } catch (error) { reject(error); }
            },
            onerror: () => reject(new Error('Traxsource playlist network error; no automatic retry.')),
            ontimeout: () => reject(new Error('Traxsource playlist timed out; no automatic retry.'))
        }));
    }

    function mergeTraxsourceIdentity(stored, identity) {
        const result = {...stored};
        for (const [key, value] of Object.entries(identity)) {
            if (value != null && value !== '' && (!Array.isArray(value) || value.length)) result[key] = value;
        }
        if (!result.labels?.length && result.cardLabel) result.labels = [result.cardLabel];
        if (!result.coverArt) result.coverArt = result.cardArtwork || '';
        if (!identity.title && stored?.title) result.title = stored.title;
        if (!identity.artists?.length && stored?.artists?.length) result.artists = stored.artists;
        const expected = identity.expectedTrackIds;
        if (expected?.length && (result.tracks?.length !== expected.length || expected.some((id, index) => result.tracks[index]?.id !== id))) result.tracklistComplete = false;
        const releaseIdentity = Boolean(result.title && result.artists?.length);
        result.completeness = {trackMetadata: result.tracklistComplete === true, releaseIdentity};
        result.level = releaseIdentity && result.tracklistComplete ? 2 : 1;
        // Catalog-derived GTIN is evidence only when it matches an explicit request;
        // keep its provenance separate instead of seeding an inferred barcode.
        return result;
    }

    function traxsourceBackgroundDocument(url,rpc=false,signal){
        return new Promise((resolve,reject)=>providerHttp(signal,{method:'GET',url,timeout:20000,
            ...(rpc?{headers:{'X-Requested-With':'XMLHttpRequest'}}:{}),
            onload:response=>{try{
                if(response.status!==200)throw new Error('Traxsource HTTP '+response.status);
                const final=new URL(response.finalUrl||url);if(final.origin!==TRAXSOURCE_ORIGIN)throw new Error('Unexpected Traxsource redirect');
                let html=response.responseText;
                if(rpc){const xml=new DOMParser().parseFromString(html,'application/xml');if(xml.querySelector('parsererror')||!xml.querySelector('root > data'))throw new Error('Traxsource builder data unavailable');html=xml.querySelector('root > data').textContent;}
                resolve(new DOMParser().parseFromString(html,'text/html'));
            }catch(error){reject(error);}},onerror:()=>reject(new Error('Traxsource network error')),ontimeout:()=>reject(new Error('Traxsource timeout'))}));
    }
    async function traxsourceBackgroundIdentity(id,signal){
        const url=TRAXSOURCE_ORIGIN+'/title/'+id;
        let doc;
        try{doc=await traxsourceBackgroundDocument(TRAXSOURCE_ORIGIN+'/scripts/builder.php/title/'+id+'?rpc=1',true,signal);}
        catch{doc=await traxsourceBackgroundDocument(url,false,signal);}
        const found=discoverTraxsourceReleases(doc,url);
        if(found.currentId!==id)throw new Error('Traxsource release identity not found');
        return found.identities.get(id);
    }
    async function traxsourceBackgroundSearch({target,observe,signal}){
        const provider=PROVIDERS.traxsource,url=provider.buildSearchUrl(target);
        try{
            if(target.url&&provider.matchesReleaseUrl(target.url))return {status:'candidate',record:{url:target.url,key:provider.getReleaseKey(target.url),level:1}};
            let doc=await traxsourceBackgroundDocument(url,false,signal);
            const choose=async doc=>{
                const records=[...discoverTraxsourceReleases(doc,url).identities.values()].filter(record=>record.title&&record.artists?.length);
                await observeProviderBatch(observe,1,records);
                const release=records.find(record=>classifyProviderMatch(provider,target,normalizeProviderObservation(provider,1,record)));
                const trackParents=new Set();
                let first=release;
                for(const row of doc.querySelectorAll('.trk-row.play-trk[data-trid]')){
                    const title=clean(row.querySelector('.title a[href*="/track/"]')?.textContent),artists=traxsourceArtists(row.querySelector('.artists'));
                    if(candidateNameScore(provider,target,{title,artists})<TITLE_MATCH_THRESHOLD_PERCENT / 100)continue;
                    const id=row.querySelector('[data-cart]')?.getAttribute('data-cart').match(/\btitle_id\s*:\s*["']?(\d+)/)?.[1];
                    if(!id||trackParents.has(id))continue;trackParents.add(id);
                    const identity=await traxsourceBackgroundIdentity(id,signal);
                    await observe(1,identity);
                    first ||= identity;
                }return first?{...first,level:1}:null;
            };
            let candidate=await choose(doc);
            if(!candidate){const general=new URL(url);general.pathname='/search';doc=await traxsourceBackgroundDocument(general.href,false,signal);candidate=await choose(doc);}
            return candidate?{status:'candidate',record:candidate}:{status:'no-match'};
        }catch(error){debugWarn('Traxsource background search unavailable',error);return {status:'interaction-required',url,reason:'search-unavailable'};}
    }
    async function traxsourceBackgroundEnrich({record,signal}){
        const id=traxsourceReleaseKey(record.url),url=TRAXSOURCE_ORIGIN+'/title/'+id;
        try{
            const identity=record.expectedTrackIds?.length?record:await traxsourceBackgroundIdentity(id,signal);
            const records=await fetchTraxsourcePlaylist([id],signal);
            const enriched=mergeTraxsourceIdentity(records.get(id),identity);
            if(!fullReleaseIsComplete(enriched))throw new Error('Traxsource complete release unavailable');
            return {status:'candidate',record:enriched};
        }catch(error){debugWarn('Traxsource background enrichment unavailable',error);return {status:'interaction-required',url,reason:'enrichment-unavailable'};}
    }

    function observeTraxsourcePage(emit) {
        let batchUsed = false, queue = Promise.resolve(), timer;
        const seen = new Map(), local = new Map();
        async function scan() {
            const {identities, currentId} = discoverTraxsourceReleases();
            const provider = PROVIDERS.traxsource;
            const cached = await readProviderCacheRecords(provider, [...identities.keys()]);
            for (const [id, record] of cached) if (!local.has(id)) local.set(id, record);
            const missing = [...identities.keys()].filter(id => !mergeTraxsourceIdentity(local.get(id), identities.get(id)).completeness.trackMetadata);
            if (!batchUsed && missing.length) {
                batchUsed = true;
                const ids = missing.slice(0, TRAXSOURCE_BATCH_LIMIT);
                debugTrace('Traxsource: playlist batch requested', null, {ids, deferred: missing.length - ids.length});
                try { for (const [id, record] of await fetchTraxsourcePlaylist(ids)) local.set(id, record); }
                catch (error) { debugWarn('[Harmony: More Provider Lookups]', error); }
            }
            const changed = [], records = [];
            for (const [id, identity] of identities) {
                const record = mergeTraxsourceIdentity(local.get(id), identity);
                local.set(id, record); records.push(record);
                const signature = JSON.stringify(record);
                if (seen.get(id) !== signature) { seen.set(id, signature); changed.push(record); }
            }
            // Store recommendations separately; only the actual page can be accepted.
            const listingChanges = changed.filter(record => record.id !== currentId);
            if (listingChanges.length) await emit({kind: 'listing', level: 1, records: listingChanges, ready: false});
            traxsourceCurrentRelease = currentId ? local.get(currentId) : null;
            if (currentId && changed.some(record => record.id === currentId)) await emit({kind: 'release', level: traxsourceCurrentRelease?.level || 1, records: traxsourceCurrentRelease ? [traxsourceCurrentRelease] : [], ready: true});
            else if (!currentId && location.pathname.startsWith('/search')) await emit({kind: 'search', level: 1, records, ready: true});
        }
        const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { queue = queue.then(scan).catch(error => debugWarn('[Harmony: More Provider Lookups]', 'Traxsource scrape failed', error)); }, 500); };
        const start = () => { schedule(); new MutationObserver(mutations => {
            if (mutations.some(mutation => [...mutation.addedNodes].some(node => node.nodeType === 1 && (node.matches?.('#ttlPageCont,.grid-item.play-ttl,.trk-row.play-trk') || node.querySelector?.('#ttlPageCont,.grid-item.play-ttl,.trk-row.play-trk'))))) schedule();
        }).observe(document.body, {childList: true, subtree: true}); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
    }

    PROVIDERS.traxsource = {
        releaseActions:{types:{artist:[['purchase for download',176]],label:[['purchase for download',959]],recording:[['purchase for download',254]]},
            entityUrl:(entity,type)=>entity.url||(/^\d+$/.test(String(entity.id||''))?TRAXSOURCE_ORIGIN+'/'+(type==='recording'?'track':type)+'/'+entity.id:''),
            identity:(value,type)=>{try{const url=new URL(value);if(!/^(www\.)?traxsource\.com$/.test(url.hostname))return '';return url.pathname.match(new RegExp('^/'+(type==='recording'?'track':type)+'/(\\d+)(?:/|$)'))?.[1]||'';}catch{return '';}}},
        lookupInputs:{gtinCache:true,gtinSearch:true},
        id: 'traxsource', name: 'Traxsource', harmony: {native: false, want: 'full-release'},
        presentation: {
            backgroundColor: 'rgb(64, 161, 255)', color: '#fff', iconSize: 16, controlIconSize: 22, controlForeground: '#fff',
            icon: {"tag":"svg","attrs":{"viewBox":"20 -130 410 410"},"children":[{"tag":"path","attrs":{"transform":"translate(0 150) scale(1 -1)","fill":"currentColor","fill-rule":"evenodd","d":"m 407.11538,92.415442 c 1.10227,7.515958 1.52102,14.875218 1.67502,26.114038 1.19142,86.68747 -74.12216,153.3477 -158.09988,153.82589 -20.55137,0.13508 -30.8338,0.13508 -51.39057,0 C 115.2925,271.87718 40.219377,206.04095 41.208177,118.52948 41.327049,107.5203 41.69177,99.769302 42.731901,92.204714 31.949662,76.446057 26.408602,55.45973 28.756325,33.095568 l 0.69162,-6.643329 c 4.619801,-43.979972 37.933705,-76.540118 74.395015,-72.706493 l 1.93167,0.202623 c 24.8902,-46.678908 68.93771,-76.207819 119.19089,-76.396929 v -0.008 h 0.11617 c 4.08217,0 7.38628,3.30411 7.38628,7.39709 v 26.297748 c 0,4.071369 -3.30411,7.370069 -7.37007,7.388981 v 0.05133 c -51.07178,0 -97.10499,62.451073 -97.10499,125.291182 0,62.107969 46.03321,125.604569 96.89696,125.604569 v -0.008 h 0.10536 c 4.08218,0 7.38898,3.3041 7.38898,7.39709 v 25.97355 c 0,4.04435 -3.25817,7.33224 -7.28631,7.38898 v 0.0675 C 170.28165,210.2447 122.85169,175.19905 99.574373,121.05821 l -13.175891,-1.38864 c -0.686216,-0.0702 -1.337311,-0.23774 -2.015422,-0.3377 -3.039343,65.68223 57.47466,113.08247 122.31668,113.44179 16.57995,0.10266 24.86858,0.10266 41.44853,0 64.76638,-0.35932 120.58493,-47.90005 118.49657,-113.612 -1.01312,0.1648 -2.01002,0.39984 -3.04205,0.50791 l -21.1052,2.22345 v -0.0216 c -0.0675,0.0135 -0.13508,0.0324 -0.19992,0.0486 -4.58198,0.4809 -8.69657,-2.83672 -9.17476,-7.41869 L 317.43449,-34.856041 c -0.48089,-4.576576 2.83402,-8.685768 7.4187,-9.155853 0.0756,-0.01081 0.13508,0.0081 0.21073,0 v -0.02972 l 21.09439,-2.212642 c 36.45861,-3.833625 69.76441,28.726521 74.38151,72.706493 l 0.70243,6.643329 c 2.36393,22.469526 -3.25007,43.539604 -14.12687,59.319874"}}]}
        },
        isCurrentSite: () => /^(www\.)?traxsource\.com$/.test(location.hostname),
        isSearchPage: () => location.pathname.startsWith('/search'),
        isReleasePage: () => Boolean(traxsourceReleaseKey(location.href)),
        matchesReleaseUrl: url => Boolean(traxsourceReleaseKey(url)), getReleaseKey: traxsourceReleaseKey,
        requireUserConfirmation: true,
        helperTokenInQuery: true,
        getComparisonValues: record => {
            if(!record)return {};
            const inferred=traxsourcePossibleGtin(record.catalogNumber || record.possibleGTIN);
            return inferred && !record.gtin ? {gtin:[{value:inferred,assumption:'assumed from catalog number'}]} : {};
        },
        buildSearchUrl: traxsourceSearchUrl, backgroundSearch:traxsourceBackgroundSearch,backgroundEnrich:traxsourceBackgroundEnrich, observePage: observeTraxsourcePage,
        getArtistUrl: artist => artist.url || (/^\d+$/.test(String(artist.id || '')) ? TRAXSOURCE_ORIGIN + '/artist/' + artist.id + (artist.slug ? '/' + encodeURIComponent(artist.slug) : '') : ''),
        getCurrentRelease: () => traxsourceCurrentRelease,
        canManuallyAccept: record => fullReleaseIsComplete(record),

    };

    // =========================================================================
    // ENTRY POINT — dispatch to Harmony adapter or resolver provider lifecycle
    // =========================================================================

    // =========================================================================
    // YOUTUBE MUSIC MODULE — parsers, background resolution and passive browsing
    // =========================================================================
    const YTM_ORIGIN='https://music.youtube.com';
    const YTM_ALBUM_TYPE='MUSIC_PAGE_TYPE_ALBUM';
    let ytmCurrentRelease=null;
    let ytmClientContext=null;
    const ytmInFlight=new Map();

    function ytmKey(url){
        try{const u=new URL(url,YTM_ORIGIN);return u.hostname==='music.youtube.com' && u.protocol==='https:' ? u.pathname.match(/^\/browse\/(MPRE[\w-]+)\/?$/)?.[1]||(u.pathname==='/playlist' && /^[\w-]+$/.test(u.searchParams.get('list')||'')?'playlist:'+u.searchParams.get('list'):'')||(u.pathname==='/watch' && /^[\w-]{11}$/.test(u.searchParams.get('v')||'')?'video:'+u.searchParams.get('v'):'') : ''; }catch{return '';}
    }
    const ytmUrl=id=>id.startsWith('playlist:')?YTM_ORIGIN+'/playlist?list='+encodeURIComponent(id.slice(9)):id.startsWith('video:')?YTM_ORIGIN+'/watch?v='+encodeURIComponent(id.slice(6)):YTM_ORIGIN+'/browse/'+encodeURIComponent(id);
    const ytmText=value=>clean(value?.runs?.map(run=>run.text||'').join('') || value?.simpleText || '');
    const ytmName=value=>clean(value?.name||value).normalize('NFKC').toLowerCase().replace(/[\u2018\u2019]/g,"'");
    function ytmWalk(value,visit){
        if(!value || typeof value!=='object')return;
        for(const [key,child]of Object.entries(value)){visit(key,child);ytmWalk(child,visit);}
    }
    function ytmFind(value,key){let found;ytmWalk(value,(name,child)=>{if(name===key && !found)found=child;});return found;}
    function ytmEndpointType(endpoint){return endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;}
    function ytmArtists(text){
        const runs=text?.runs||[];
        const linked=runs.filter(run=>ytmEndpointType(run.navigationEndpoint?.browseEndpoint)==='MUSIC_PAGE_TYPE_ARTIST');
        if(linked.length)return linked.map(run=>({name:clean(run.text),id:run.navigationEndpoint.browseEndpoint.browseId,url:YTM_ORIGIN+'/channel/'+run.navigationEndpoint.browseEndpoint.browseId}));
        const name=ytmText(text);return name?[{name}]:[];
    }
    function ytmArt(value){const thumbs=ytmFind(value?.thumbnail||value?.thumbnailRenderer||value,'thumbnails')||[];return [...thumbs].sort((a,b)=>(b.width||0)-(a.width||0)).find(item=>/^https:\/\//.test(item.url||''))?.url||'';}
    function ytmDuration(value){return /^\d+(?::\d{2}){1,2}$/.test(value||'')?value.split(':').reduce((n,part)=>n*60+Number(part),0)*1000:null;}

    // Decode data literals without executing site JavaScript or using eval/Function.
    function ytmQuoted(source,start){
        const quote=source[start];if(!['"',"'"].includes(quote))throw new Error('Expected quoted YTM data');
        let value='',i=start+1;
        for(;i<source.length;i++){
            let char=source[i];if(char===quote)return {value,end:i+1};
            if(char==='\\'){
                char=source[++i];
                if(char==='x'||char==='u'){
                    const count=char==='x'?2:4,hex=source.slice(i+1,i+1+count);
                    if(!new RegExp('^[a-fA-F0-9]{'+count+'}$').test(hex))throw new Error('Invalid YTM string escape');
                    value+=String.fromCharCode(parseInt(hex,16));i+=count;
                }else if(['n','r','t','b','f','v'].includes(char))value+={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v'}[char];
                else if(['\\','/','"',"'"].includes(char))value+=char;
                else throw new Error('Unsupported YTM string escape');
            }else value+=char;
        }
        throw new Error('Unterminated YTM data string');
    }
    function ytmJsonObject(source,start){
        let depth=0;
        for(let i=start;i<source.length;i++){
            if(source[i]==='"'){i=ytmQuoted(source,i).end-1;continue;}
            if(source[i]==='{')depth++;
            if(source[i]==='}' && --depth===0)return JSON.parse(source.slice(start,i+1));
        }
        throw new Error('Incomplete YTM JSON');
    }
    function ytmInitialData(html,path){
        const marker=/initialData\.push\(\{\s*path:\s*/g;let match;
        while((match=marker.exec(html))){
            const route=ytmQuoted(html,marker.lastIndex);
            const end=html.indexOf('initialData.push(',route.end),limit=end<0?html.length:end;
            const data=/\bdata:\s*/g;data.lastIndex=route.end;const hit=data.exec(html);
            if(route.value===path && hit && hit.index<limit)return JSON.parse(ytmQuoted(html,data.lastIndex).value);
        }
        throw new Error('YTM response did not contain '+path+' initial data');
    }
    function ytmContext(html){
        const markers=[/"INNERTUBE_CONTEXT"\s*:\s*/g];
        let candidate;
        const hit=markers[0].exec(html);
        if(hit)candidate=ytmJsonObject(html,markers[0].lastIndex).client;
        const client=ytmSafeClient(candidate);
        if(!client)throw new Error('Current YTM client context unavailable');
        return client;
    }
    function ytmSafeClient(client){
        if(client?.clientName!=='WEB_REMIX'||!/^\d[\d.]+$/.test(client.clientVersion||''))return null;
        return {hl:'en',gl:/^[A-Z]{2}$/.test(client.gl||'')?client.gl:'US',clientName:'WEB_REMIX',clientVersion:client.clientVersion,platform:'DESKTOP'};
    }
    function ytmRequest(url,body=null,signal){
        const destination=new URL(url);
        // Tampermonkey supplies existing browser cookies only for the watch
        // document. Never read, copy or persist session credentials ourselves.
        const useBrowserSession=!body && destination.origin==='https://www.youtube.com' && destination.pathname==='/watch';
        debugTrace('YTM: requesting document',null,{host:destination.hostname,path:destination.pathname,browserSession:useBrowserSession});
        return new Promise((resolve,reject)=>providerHttp(signal,{method:body?'POST':'GET',url,anonymous:!useBrowserSession,timeout:20000,
            ...(body?{headers:{'Content-Type':'application/json','X-Origin':YTM_ORIGIN,'X-YouTube-Client-Name':'67','X-YouTube-Client-Version':body.context.client.clientVersion},data:JSON.stringify(body)}:{}),
            onload:response=>{
                if(response.status!==200)return reject(new Error('YTM HTTP '+response.status+'; no automatic retry'));
                if(response.finalUrl && !['music.youtube.com','www.youtube.com'].includes(new URL(response.finalUrl).hostname))return reject(new Error('YTM redirected to consent or verification'));
                if(response.responseText.length>15000000)return reject(new Error('YTM response exceeds parser limit'));
                resolve(response.responseText);
            },onerror:()=>reject(new Error('YTM network request failed')),ontimeout:()=>reject(new Error('YTM request timed out'))
        }));
    }

    function ytmSearchScope(data){
        const tabs=data?.contents?.tabbedSearchResultsRenderer?.tabs;
        return tabs ? tabs.find(tab=>tab.tabRenderer?.selected)?.tabRenderer.content || null : data;
    }
    function ytmSearchArtists(card){
        const runs=[...(card.subtitle?.runs||[]),...(card.flexColumns||[]).slice(1).flatMap(column=>column.musicResponsiveListItemFlexColumnRenderer?.text?.runs||[])];
        const linked=runs.filter(run=>ytmEndpointType(run.navigationEndpoint?.browseEndpoint)==='MUSIC_PAGE_TYPE_ARTIST');
        if(linked.length)return [...new Map(ytmArtists({runs:linked}).map(artist=>[ytmName(artist),artist])).values()];
        // Same explicit type/credit subtitle layout used by live DOM cards.
        // Keep the complete credit; never interpret album names or play counts as artists.
        const parts=ytmText(card.subtitle).split(/\s*[•\u0007]\s*/);
        const at=parts.findIndex(part=>/^(Song|Album|EP|Single)$/i.test(part));
        return at>=0 && parts[at+1] && !/^\d{4}$|plays$|views$/i.test(parts[at+1])?[{name:parts[at+1]}]:[];
    }
    function ytmSearchRecords(data,includeSongs=false){
        data=ytmSearchScope(data);
        const releases=new Map();
        ytmWalk(data,(name,card)=>{
            if(!['musicCardShelfRenderer','musicTwoRowItemRenderer','musicResponsiveListItemRenderer'].includes(name))return;
            const endpoint=card.navigationEndpoint?.browseEndpoint || card.title?.runs?.find(run=>run.navigationEndpoint?.browseEndpoint)?.navigationEndpoint.browseEndpoint || card.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.browseEndpoint;
            if(ytmEndpointType(endpoint)!==YTM_ALBUM_TYPE || !/^MPRE[\w-]+$/.test(endpoint.browseId||'')){
                if(!includeSongs)return;
                const watch=card.navigationEndpoint?.watchEndpoint || card.title?.runs?.find(run=>run.navigationEndpoint?.watchEndpoint)?.navigationEndpoint.watchEndpoint || card.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.find(run=>run.navigationEndpoint?.watchEndpoint)?.navigationEndpoint.watchEndpoint;
                const videoId=watch?.videoId;
                const runs=[...(card.subtitle?.runs||[]),...(card.flexColumns||[]).slice(1).flatMap(column=>column.musicResponsiveListItemFlexColumnRenderer?.text?.runs||[])];
                const type=watch?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;
                if(!/^[\w-]{11}$/.test(videoId||'') || !(type==='MUSIC_VIDEO_TYPE_ATV'||runs.some(run=>/^Song$/i.test(clean(run.text)))))return;
                const title=ytmText(card.title||card.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
                const artists=ytmSearchArtists(card);
                const albumIds=new Set();ytmWalk(card,(name,value)=>{if(name==='browseEndpoint'&&ytmEndpointType(value)===YTM_ALBUM_TYPE&&/^MPRE/.test(value.browseId||''))albumIds.add(value.browseId);});
                const key='video:'+videoId;
                if(title)releases.set(key,{id:key,key,url:ytmUrl(key),title,artists,level:1,watchSelection:true,albumBrowseId:albumIds.size===1?[...albumIds][0]:''});
                return;
            }
            const title=ytmText(card.title||card.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
            const artists=ytmSearchArtists(card);
            const id=endpoint.browseId;
            if(title)releases.set(id,{id,key:id,browseId:id,url:ytmUrl(id),title,artists,coverArt:ytmArt(card),playlistId:ytmFind(card,'watchPlaylistEndpoint')?.playlistId||ytmFind(card,'watchEndpoint')?.playlistId||'',level:1});
        });
        return [...releases.values()];
    }
    function ytmEvidence(records,gtin,completeSearch=true){
        if(!gtin)return records;
        return records.map(record=>({...record,identityEvidence:[{kind:'quoted-gtin-search',gtin,uniqueRelease:completeSearch && records.length===1}]}));
    }
    function ytmGtinQuery(query){const match=clean(query).match(/^"(\d{8}|\d{12,14})"$/);return match?.[1]||'';}
    function ytmPlaylistId(header,tracks){
        const ids=new Set(tracks.map(track=>track.playlistId).filter(Boolean));
        // Only the release header's playback controls and the actual tracklist.
        // Recommendation shelves and menus elsewhere in the response are ignored.
        for(const button of header?.buttons||[]){
            const endpoint=button.musicPlayButtonRenderer?.playNavigationEndpoint;
            const playlistId=endpoint?.watchPlaylistEndpoint?.playlistId||endpoint?.watchEndpoint?.playlistId;
            if(playlistId)ids.add(playlistId);
        }
        if(ids.size>1)throw new Error('YTM album playback controls conflict with its tracklist playlist IDs');
        return ids.size===1 && /^[\w-]+$/.test([...ids][0])?[...ids][0]:'';
    }
    function ytmCanonicalRelease(record){
        const ids=new Set([record.playlistId,...(record.tracks||[]).map(track=>track.playlistId)].filter(Boolean));
        if(ids.size!==1 || !/^[\w-]+$/.test([...ids][0]))throw new Error('YTM album playlist identity is missing or conflicting');
        const playlistId=[...ids][0],url=YTM_ORIGIN+'/playlist?'+new URLSearchParams({list:playlistId});
        return {...record,playlistId,url,externalLinks:[{url,types:['free streaming']}]};
    }
    function ytmQueueRows(next){
        const rows=[];
        const tabs=next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs||[];
        for(const tab of tabs)for(const item of tab.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents||[]){
            const wrapper=item.playlistPanelVideoWrapperRenderer;
            if(wrapper){
                const primary=wrapper.primaryRenderer?.playlistPanelVideoRenderer;
                const counterparts=(wrapper.counterpart||[]).map(value=>value.counterpartRenderer?.playlistPanelVideoRenderer).filter(Boolean);
                for(const row of [primary,...counterparts].filter(Boolean))rows.push({row,related:[primary,...counterparts].filter(Boolean)});
            }else if(item.playlistPanelVideoRenderer)rows.push({row:item.playlistPanelVideoRenderer,related:[]});
        }
        return rows;
    }
    const ytmNextResponses=new Map();
    async function ytmNext(videoId,playlistId,client,signal){
        const key=videoId+':'+(playlistId||'');
        if(ytmNextResponses.has(key))return ytmNextResponses.get(key);
        if(!client)throw new Error('YTM client context not ready');
        const response=JSON.parse(await ytmRequest(YTM_ORIGIN+'/youtubei/v1/next?prettyPrint=false',{
            context:{client},videoId,...(playlistId?{playlistId}:{}),isAudioOnly:true,enablePersistentPlaylistPanel:true,
            watchEndpointMusicSupportedConfigs:{watchEndpointMusicConfig:{hasPersistentPlaylistPanel:true,musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}
        },signal));
        if(ytmNextResponses.size>=50)ytmNextResponses.delete(ytmNextResponses.keys().next().value);
        ytmNextResponses.set(key,response);return response;
    }
    function ytmAudioCandidates(next,videoId){
        const ids=new Set();
        for(const {row,related} of ytmQueueRows(next))if(row.videoId===videoId)for(const other of related){
            if(other.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType==='MUSIC_VIDEO_TYPE_ATV')ids.add(other.videoId);
        }
        // A Like target is only a discovery hint, never proof of recording identity.
        if(next.currentVideoEndpoint?.watchEndpoint?.videoId===videoId)for(const action of next.playerOverlays?.playerOverlayRenderer?.actions||[])ids.add(action.likeButtonRenderer?.target?.videoId);
        return [...ids].filter(id=>/^[\w-]{11}$/.test(id||'')&&id!==videoId);
    }
    function ytmWatchMatches(watch,track,album){
        return ytmName(watch.songTitle)===ytmName(track.title)&&ytmName(watch.releaseTitle)===ytmName(album.title)&&
            watch.songArtists.some(a=>(track.artists||[]).some(b=>normalizeCandidateArtist(a.name)===normalizeCandidateArtist(b.name)));
    }
    async function ytmAudioTrack(track,album,client,signal){
        const read=id=>ytmRequest('https://www.youtube.com/watch?v='+encodeURIComponent(id),null,signal).then(html=>ytmWatch(html,id));
        if(track.musicVideoType==='MUSIC_VIDEO_TYPE_ATV')return {track,watch:await read(track.videoId)};
        // Unknown types can still be verified by their distributor-generated description.
        if(!track.musicVideoType){try{const watch=await read(track.videoId);if(ytmWatchMatches(watch,track,album))return {track:{...track,audioVerified:true},watch};}catch(error){if(signal?.aborted)throw error;}}
        const next=await ytmNext(track.videoId,album.playlistId,client,signal);
        for(const id of ytmAudioCandidates(next,track.videoId)){
            try{
                const watch=await read(id);
                if(!ytmWatchMatches(watch,track,album))continue;
                return {track:{...track,audioVideoId:id,audioVerified:true,url:YTM_ORIGIN+'/watch?v='+id},watch};
            }catch(error){if(signal?.aborted)throw error;}
        }
        throw new Error('YTM audio counterpart could not be verified');
    }
    function ytmSelectedAlbum(root,videoId){
        const ids=new Set();
        for(const {row,related} of ytmQueueRows(root?.watchNextResponse)){
            if(![row,...related].some(value=>value.videoId===videoId))continue;
            for(const run of row.longBylineText?.runs||[]){
                const endpoint=run.navigationEndpoint?.browseEndpoint;
                if(endpoint && (ytmEndpointType(endpoint)===YTM_ALBUM_TYPE || (!ytmEndpointType(endpoint) && /^MPRE/.test(endpoint.browseId||''))))ids.add(endpoint.browseId);
            }
        }
        return ids.size===1?[...ids][0]:'';
    }
    function ytmAlbum(data,id){
        const layout=data.contents?.twoColumnBrowseResultsRenderer;
        if(!layout)throw new Error('YTM album layout unavailable');
        const header=ytmFind(layout.tabs,'musicResponsiveHeaderRenderer')||ytmFind(data.header,'musicDetailHeaderRenderer');
        if(!header)throw new Error('YTM album header unavailable');
        const title=ytmText(header.title),artists=ytmArtists(header.straplineTextOne||header.straplineText);
        const subtitle=ytmText(header.subtitle),countText=ytmText(header.secondSubtitle);
        const expected=Number(countText.match(/([\d,]+)\s+(?:songs?|tracks?)/i)?.[1].replace(/,/g,'')||0);
        const rows=[];
        for(const shelf of layout.secondaryContents?.sectionListRenderer?.contents||[]){
            for(const item of shelf.musicShelfRenderer?.contents||[])if(item.musicResponsiveListItemRenderer)rows.push(item.musicResponsiveListItemRenderer);
        }
        let continuation=false;ytmWalk(layout.secondaryContents,(name)=>{if(name==='continuations'||name==='continuationItemRenderer')continuation=true;});
        const tracks=rows.map((row,index)=>{
            const columns=row.flexColumns?.map(value=>value.musicResponsiveListItemFlexColumnRenderer?.text)||[];
            const endpoint=ytmFind(row.overlay,'watchEndpoint')||ytmFind(columns[0],'watchEndpoint');
            const videoId=row.playlistItemData?.videoId||endpoint?.videoId;
            const credits=[];ytmWalk(row.menu,(name,value)=>{if(name==='browseEndpoint' && ytmEndpointType(value)==='MUSIC_PAGE_TYPE_TRACK_CREDITS')credits.push(value.browseId);});
            let credit=columns.slice(1).flatMap(value=>ytmArtists({runs:(value?.runs||[]).filter(run=>ytmEndpointType(run.navigationEndpoint?.browseEndpoint)==='MUSIC_PAGE_TYPE_ARTIST')}));
            if(!credit.length && artists.length && !artists.some(artist=>/^(various artists|various)$/i.test(artist.name)))credit=artists;
            return {id:videoId,videoId,number:ytmText(row.index)||String(index+1),title:ytmText(columns[0]),artists:credit,
                length:ytmDuration(ytmText(row.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text)),url:videoId?YTM_ORIGIN+'/watch?v='+encodeURIComponent(videoId):'',
                playlistId:endpoint?.playlistId,playCountText:columns.map(ytmText).find(text=>/plays?$/i.test(text))||'',musicVideoType:endpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType,creditsBrowseId:credits[0]||''};
        });
        const complete=!continuation && expected>0 && expected===tracks.length && new Set(tracks.map(track=>track.videoId)).size===tracks.length && tracks.every((track,index)=>/^[\w-]{11}$/.test(track.videoId||'') && track.title && track.artists.length && Number(track.number)===index+1);
        return {id,key:id,browseId:id,url:ytmUrl(id),title,artists,coverArt:ytmArt(header),type:subtitle.split('•')[0].trim(),year:subtitle.match(/\b\d{4}\b/)?.[0]||'',trackCount:expected,totalDuration:tracks.every(track=>track.length)?tracks.reduce((sum,track)=>sum+track.length,0):null,tracks,tracklistComplete:complete,
            playlistId:ytmPlaylistId(header,tracks),completeness:{tracklist:complete,watch:false},level:1};
    }
    function ytmWatch(html,videoId){
        const marker=/(?:var\s+)?ytInitialPlayerResponse\s*=\s*/g,hit=marker.exec(html);
        if(!hit)throw new Error('YouTube watch player data unavailable');
        const player=ytmJsonObject(html,marker.lastIndex),details=player.videoDetails;
        if(details?.videoId!==videoId){
            // Report only the fields needed to diagnose the response; never dump
            // player payloads, visitor data or request credentials into the log.
            const diagnostic={expectedVideoId:videoId,actualVideoId:details?.videoId||null,
                status:player.playabilityStatus?.status||'unknown',
                reason:clean(player.playabilityStatus?.reason||''),
                messages:(player.playabilityStatus?.messages||[]).filter(value=>typeof value==='string')};
            debugTrace('YTM: watch metadata unavailable',null,diagnostic);
            throw new Error('YouTube watch '+(details?.videoId?'video ID mismatch':'has no video details')+'; '+JSON.stringify(diagnostic));
        }
        const description=details.shortDescription||'';
        if(!/Auto-generated by YouTube\./i.test(description))throw new Error('YouTube watch lacks distributor-generated metadata');
        const micro=player.microformat?.playerMicroformatRenderer||{};
        const lines=description.split(/\r?\n/).map(clean).filter(Boolean);
        const phonographicCopyright=lines.find(line=>/^℗\s/.test(line))||'',copyright=lines.find(line=>/^©\s/.test(line))||'';
        const releaseDate=lines.find(line=>/^Released on:\s*\d{4}-\d{2}-\d{2}$/.test(line))?.split(':')[1].trim()||'';
        const suppliedAt=lines.findIndex(line=>/^Provided to YouTube by /i.test(line));
        const creditLine=suppliedAt>=0?lines[suppliedAt+1]||'':'';
        const creditParts=creditLine.split(/\s*·\s*/);
        const songTitle=creditParts.length>1?creditParts[0]:'';
        const songArtists=creditParts.slice(1).map(name=>({name}));
        const releaseTitle=suppliedAt>=0?lines[suppliedAt+2]||'':'';
        return {videoId,songTitle,songArtists,releaseTitle,coverArt:details.thumbnail?.thumbnails?.slice(-1)[0]?.url||'',releaseDate,distributor:lines.find(line=>/^Provided to YouTube by /i.test(line))?.replace(/^Provided to YouTube by /i,'')||'',phonographicCopyright,copyright,
            uploadDate:micro.uploadDate||'',datePublished:micro.publishDate||'',regionsAllowed:micro.availableCountries||[],length:Number(details.lengthSeconds)*1000||null,
            credits:lines.filter(line=>/^(Producer|Composer|Music Publisher):/.test(line))};
    }
    function ytmEnriched(album,watch){
        const labels=[watch.phonographicCopyright,watch.copyright].filter(Boolean).map(line=>({value:line.replace(/^[℗©]\s*\d{4}\s*/,''),assumption:'possible label from copyright line: '+line}));
        return ytmCanonicalRelease({...album,level:2,date:watch.releaseDate,types:/^(Album|EP|Single)$/i.test(album.type||'')?[album.type]:[],copyright:[watch.phonographicCopyright,watch.copyright].filter(Boolean).join('; '),firstTrackMetadata:watch,distributor:watch.distributor,
            completeness:{tracklist:album.tracklistComplete,watch:true},
            comparisonValues:{label:labels,date:[{value:watch.releaseDate,notifier:'Released on: distributor-supplied release date'},{value:normalizeDate(watch.datePublished),notifier:'YouTube publication date'},{value:normalizeDate(watch.uploadDate),notifier:'YouTube upload date'}].filter(item=>item.value)},
            externalLinks:[{url:album.url,types:['free streaming']}]});
    }
    async function ytmCachedRelease(album){
        const key=album.key||ytmKey(album.url),videoId=key?.startsWith('video:')?key.slice(6):'';
        const identity=videoId?album.albumBrowseId:key;
        if(!identity)return null;
        const matches=record=>{
            if(record.provider!=='ytmusic'||record.level!==2||!record.tracklistComplete||!record.completeness?.watch||!fullReleaseIsComplete(record))return null;
            if(![record.key,record.browseId,record.playlistId&&'playlist:'+record.playlistId].includes(identity))return null;
            if(album.trackCount>0&&record.trackCount!==album.trackCount)return null;
            if(videoId&&!record.tracks.some(track=>[track.videoId||track.id,track.audioVideoId].includes(videoId)))return null;
            try{
                const result=ytmCanonicalRelease(record);
                return videoId?{...result,selectedVideoId:videoId,watchSelection:true}:result;
            }catch{return null;}
        };
        const direct=(await readProviderCacheRecords(PROVIDERS.ytmusic,[identity])).get(identity);
        const found=direct&&matches(direct);if(found)return found;
        // The same album can be stored under its browse ID or canonical playlist ID.
        const meta=await GM_getValue(CACHE_META_KEY,{1:[],2:[]});
        for(const blockKey of meta[2]||[]){
            const block=await GM_getValue(blockKey,[]);
            for(let i=block.length-1;i>=0;i--){const hit=matches(block[i]);if(hit)return hit;}
        }
        return null;
    }
    async function ytmEnrich(album,client,signal){
        const cached=await ytmCachedRelease(album);if(cached)return cached;
        const id=album.key;
        if(!signal&&ytmInFlight.has(id))return ytmInFlight.get(id);
        const run=(async()=>{
            if(id.startsWith('video:')){
                const videoId=id.slice(6);let browseId=album.albumBrowseId;
                if(!browseId){
                    const next=await ytmNext(videoId,null,client,signal);
                    browseId=ytmSelectedAlbum({watchNextResponse:next},videoId);
                    if(!browseId)for(const candidate of ytmAudioCandidates(next,videoId)){
                        const audioNext=await ytmNext(candidate,null,client,signal);
                        browseId=ytmSelectedAlbum({watchNextResponse:audioNext},candidate);
                        if(browseId)break;
                    }
                }
                if(!browseId || !client)throw new Error('Waiting for the selected video’s album relationship and client context');
                const details=ytmAlbum(JSON.parse(await ytmRequest(YTM_ORIGIN+'/youtubei/v1/browse?prettyPrint=false',{context:{client},browseId},signal)),browseId);
                if(!details.tracklistComplete)throw new Error('YTM parent album has an incomplete tracklist');
                const enriched=await ytmEnrich(details,client,signal);
                if(!enriched.tracks.some(track=>[track.videoId,track.audioVideoId].includes(videoId)))throw new Error('YTM parent album does not contain the selected recording');
                return {...enriched,selectedVideoId:videoId,watchSelection:true};
            }
            let details=album;
            if(!details.tracklistComplete){
                if(!client)throw new Error('YTM client context not ready');
                if(id.startsWith('playlist:'))throw new Error('YTM playlist tracklist is not ready');
                details={...album,...ytmAlbum(JSON.parse(await ytmRequest(YTM_ORIGIN+'/youtubei/v1/browse?prettyPrint=false',{context:{client},browseId:id},signal)),id)};
            }
            details=ytmCanonicalRelease(details);
            if(!details.tracklistComplete)throw new Error('YTM tracklist is incomplete; manual comparison required');
            const tracks=[...details.tracks];let watch;
            for(let index=0;index<tracks.length;index++){
                if(index>0&&tracks[index].musicVideoType==='MUSIC_VIDEO_TYPE_ATV')continue;
                try{const audio=await ytmAudioTrack(tracks[index],details,client,signal);tracks[index]=audio.track;if(index===0)watch=audio.watch;}
                catch(error){if(index===0||signal?.aborted)throw error;debugWarn('YTM: recording link left unresolved',error);}
            }
            return ytmEnriched({...details,tracks},watch);
        })();
        if(!signal)ytmInFlight.set(id,run);try{return await run;}finally{if(!signal)ytmInFlight.delete(id);}
    }
    function ytmAutoAccept(target,record){
        const count=Number(target.trackCount);
        return Boolean(!record.watchSelection && record.url?.startsWith(YTM_ORIGIN+'/playlist?list=') && count>0 && Number.isInteger(count) && record.tracklistComplete && record.completeness?.watch && record.tracks?.length===count && record.trackCount===count &&
            record.identityEvidence?.some(evidence=>evidence.kind==='quoted-gtin-search' && evidence.uniqueRelease && gtinsMatch(evidence.gtin,target.gtin)));
    }
    function ytmCandidates(target,records){
        // Explicit album/playlist identities and track membership, not similar titles.
        const groups=[];
        for(const record of records){
            const aliases=new Set([record.key,record.browseId,record.albumBrowseId,
                record.playlistId&&'playlist:'+record.playlistId].filter(Boolean));
            const contains=(album,song)=>!song.albumBrowseId&&song.key?.startsWith('video:')&&(album.tracks||[]).some(track=>'video:'+(track.videoId||track.id)===song.key)&&
                new Set(records.filter(other=>(other.tracks||[]).some(track=>'video:'+(track.videoId||track.id)===song.key)).map(other=>other.playlistId||other.browseId||other.key)).size===1;
            const matches=groups.filter(group=>[...aliases].some(id=>group.aliases.has(id))||group.records.some(other=>contains(record,other)||contains(other,record)));
            const group={aliases,records:[record]};
            for(const match of matches){match.aliases.forEach(id=>aliases.add(id));group.records.push(...match.records);groups.splice(groups.indexOf(match),1);}
            groups.push(group);
        }
        const merged=groups.map(group=>{
            const preferred=group.records.sort((a,b)=>b.level-a.level||Number(Boolean(a.watchSelection))-Number(Boolean(b.watchSelection)))[0];
            return {...preferred,identityEvidence:group.records.flatMap(record=>record.identityEvidence||[])};
        });
        const barcode=merged.filter(record=>record.identityEvidence.some(item=>item.kind==='quoted-gtin-search'&&gtinsMatch(item.gtin,target.gtin)));
        return barcode.length?barcode:merged;
    }
    function ytmBarcodeSearchUrl(gtin){return YTM_ORIGIN+'/search?'+new URLSearchParams({q:'"'+gtin+'"'});}

    async function ytmBackgroundSearch({target,observe,signal,barcodeOnly=false}) {
        const provider=PROVIDERS.ytmusic;
        if(!providerLookupInput(provider,target).usable)return {status:'no-match'};
        let url=provider.buildSearchUrl(target);
        try {
            if(/^\d{8}$|^\d{12,14}$/.test(clean(target.gtin))){
                url=ytmBarcodeSearchUrl(clean(target.gtin));
                const html=await ytmRequest(url,null,signal);
                ytmClientContext=ytmContext(html);
                const data=ytmInitialData(html,'/search');
                let complete=true;
                ytmWalk(ytmSearchScope(data),name=>{if(name==='continuations'||name==='continuationItemRenderer')complete=false;});
                const records=ytmEvidence(ytmSearchRecords(data),target.gtin,complete);
                await observeProviderBatch(observe,1,records);
                debugTrace('YTM: quoted GTIN search parsed',null,{gtin:target.gtin,releases:records.length});
                if(records.length)return {status:'candidate',record:records[0]};
            }
            if(barcodeOnly||!providerLookupInput(provider,target).searchable)return {status:'no-match'};
            url=provider.buildSearchUrl(target);
            const html=await ytmRequest(url,null,signal);
            ytmClientContext=ytmContext(html);
            const records=ytmSearchRecords(ytmInitialData(html,'/search'),true);
            await observeProviderBatch(observe,1,records);
            // Return a preferred result; the shared resolver also collects eligible observed alternatives.
            const candidate=records.find(record=>classifyProviderMatch(provider,target,normalizeProviderObservation(provider,1,record)));
            debugTrace('YTM: background artist/title candidates evaluated',null,{results:records.length,candidate:candidate?.key,
                target:{title:target.title,artists:target.artists,normalizedTitle:ytmName(target.title),normalizedArtists:(target.artists||[]).map(ytmName)},
                candidates:records.map(record=>({key:record.key,title:record.title,artists:record.artists,
                    normalizedTitle:ytmName(record.title),normalizedArtists:record.artists.map(ytmName),
                    score:candidateNameScore(provider,target,record),threshold:TITLE_MATCH_THRESHOLD_PERCENT / 100,
                    titleMatches:ytmName(target.title)===ytmName(record.title),
                    artistsMatch:(target.artists||[]).map(ytmName).join(' & ')===record.artists.map(ytmName).join(' & ')}))});
            return candidate?{status:'candidate',record:candidate}:{status:'no-match'};
        } catch(error) {
            debugWarn('YTM: background text search requires interaction',error);
            return {status:'interaction-required',url,reason:'search-unavailable'};
        }
    }
    async function ytmBackgroundEnrich({target,record,signal}) {
        try {
            const retain=release=>({...release,identityEvidence:[...new Map([...(release.identityEvidence||[]),...(record.identityEvidence||[])].map(item=>[JSON.stringify(item),item])).values()]});
            const cached=await ytmCachedRelease(record);if(cached)return {status:'candidate',record:retain(cached)};
            if(!ytmClientContext||(record.key?.startsWith('playlist:')&&!record.tracklistComplete)){
                const html=await ytmRequest(record.url,null,signal);
                ytmClientContext=ytmContext(html);
                if(record.key?.startsWith('playlist:')&&!record.tracklistComplete){
                    const details=ytmAlbum(ytmInitialData(html,'/browse'),record.key);
                    if(details.playlistId!==record.key.slice(9))throw new Error('YTM document does not match the linked playlist');
                    record={...record,...details};
                }
            }
            const enriched=await ytmEnrich(record,ytmClientContext,signal);
            // Text matches are candidates only; do not manufacture GTIN evidence.
            return {status:'candidate',record:retain(enriched)};
        } catch(error) {
            debugWarn('YTM: candidate enrichment requires interaction',error);
            return {status:'interaction-required',url:record.url||PROVIDERS.ytmusic.buildSearchUrl(target),reason:'enrichment-unavailable'};
        }
    }

    function ytmActiveRoot(){
        if(location.pathname==='/watch')return document.querySelector('ytmusic-player-page:not([hidden])');
        if(location.pathname==='/search')return document.querySelector('ytmusic-search-page:not([hidden])')||document.querySelector('ytmusic-tabbed-search-results-renderer:not([hidden])');
        return document.querySelector('ytmusic-browse-response:not([hidden])');
    }
    function ytmLiveData(){
        try{return unsafeWindow.ytcfg?.get?.('YTMUSIC_INITIAL_DATA')||[];}catch{return [];}
    }
    function ytmDomCards(root){
        const records=new Map();
        for(const card of root.querySelectorAll('ytmusic-two-row-item-renderer,ytmusic-card-shelf-renderer,ytmusic-responsive-list-item-renderer')){
            if(card.closest('[hidden]'))continue;
            // Polymer's live data retains the typed target omitted from HTML attributes.
            let data;try{data=card.data;}catch{}
            const typed=data?ytmSearchRecords({musicTwoRowItemRenderer:data}):[];
            if(typed.length){for(const record of typed)records.set(record.key,record);continue;}
            const link=card.querySelector('.title a[href*="browse/MPRE"],a.title[href*="browse/MPRE"]');
            const id=link && ytmKey(new URL(link.getAttribute('href'),YTM_ORIGIN).href);
            if(!id){
                const song=card.querySelector('.title a[href*="watch?"],a.title[href*="watch?"]');
                const subtitle=clean(card.querySelector('.subtitle')?.textContent);
                const key=song && ytmKey(new URL(song.getAttribute('href'),YTM_ORIGIN).href);
                if(key && /(?:^|•)\s*Song\s*(?:•|$)/i.test(subtitle)){
                    const parts=subtitle.split(/\s*•\s*/);const at=parts.findIndex(part=>/^Song$/i.test(part));
                    records.set(key,{id:key,key,url:ytmUrl(key),title:clean(song.textContent),artists:parts[at+1]?[{name:parts[at+1]}]:[],level:1,watchSelection:true});
                }
                continue;
            } // MPRE is the album namespace; playlists use other IDs.
            const subtitle=clean(card.querySelector('.subtitle')?.textContent).split(/\s*•\s*/);
            const typeIndex=subtitle.findIndex(value=>/^(Album|EP|Single)$/i.test(value));
            const artists=typeIndex>=0 && subtitle[typeIndex+1]?[{name:subtitle[typeIndex+1]}]:[];
            records.set(id,{id,key:id,browseId:id,url:ytmUrl(id),title:clean(link.textContent||link.title),artists,coverArt:card.querySelector('img')?.src||'',level:1});
        }
        return [...records.values()];
    }
    function ytmDomCover(header){
        const image=header.querySelector('ytmusic-thumbnail-renderer.thumbnail:not(.strapline-thumbnail) img,ytmusic-thumbnail-renderer#thumbnail img')||header.querySelector('img.fullscreen-art');
        const src=image?.src||'';
        try{const url=new URL(src);if(url.hostname==='yt3.googleusercontent.com'){url.pathname=url.pathname.replace(/=(?:w\d+|s\d+)[^/]*$/,'=s0');url.search='?imgmax=0';return url.href;}}catch{}
        return src;
    }
    function ytmDomAlbum(root,id){
        const header=root.querySelector('ytmusic-responsive-header-renderer,ytmusic-detail-header-renderer');
        if(!header)return null;
        const name=clean(header.querySelector('.strapline-text')?.textContent),artists=name?[{name}]:[];
        const expected=Number(clean(header.querySelector('.second-subtitle')?.textContent).match(/([\d,]+)\s+(?:songs?|tracks?)/)?.[1].replace(/,/g,'')||0);
        const tracks=[];
        for(const row of root.querySelectorAll('ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer')){
            if(row.closest('[hidden]'))continue;
            const link=row.querySelector('.title a[href*="watch?"]');if(!link)continue;
            const url=new URL(link.getAttribute('href'),YTM_ORIGIN),videoId=url.searchParams.get('v');
            const links=[...row.querySelectorAll('.secondary-flex-columns a[href*="channel/"],.secondary-flex-columns a[href*="browse/UC"]')];
            const credit=links.length?links.map(a=>({name:clean(a.textContent),url:new URL(a.getAttribute('href'),YTM_ORIGIN).href})):artists;
            tracks.push({number:String(tracks.length+1),id:videoId,videoId,title:clean(link.textContent),artists:credit,length:ytmDuration(clean(row.querySelector('.fixed-column')?.textContent)),url:YTM_ORIGIN+'/watch?v='+videoId,playlistId:url.searchParams.get('list')||''});
        }
        const complete=expected>0 && tracks.length===expected && new Set(tracks.map(track=>track.videoId)).size===expected && tracks.every(track=>/^[\w-]{11}$/.test(track.videoId||'') && track.title && track.artists.length && !track.artists.some(artist=>/^(various artists|various)$/i.test(artist.name)));
        const subtitle=clean(header.querySelector('.subtitle')?.textContent);
        return {id,key:id,browseId:id,url:ytmUrl(id),title:clean(header.querySelector('.title')?.textContent),artists,coverArt:ytmDomCover(header),type:subtitle.split('•')[0].trim(),year:subtitle.match(/\b\d{4}\b/)?.[0]||'',tracks,trackCount:expected,totalDuration:tracks.every(track=>track.length)?tracks.reduce((sum,track)=>sum+track.length,0):null,tracklistComplete:complete,playlistId:ytmPlaylistId(null,tracks)|| (id.startsWith('playlist:')?id.slice(9):''),completeness:{tracklist:complete,watch:false},level:1};
    }
    function ytmObserve(emit){
        let timer,epoch=0,route='',running=false,again=false,navigating=false,lastReleaseSignature='';
        const seen=new Map(),attempted=new Set(),resolvedWatches=new Map();
        const pageIdentity=()=>location.pathname+location.search.replace(/([?&])hmpl-request=[^&]*&?/,'$1');
        async function scan(){
            if(navigating)return;
            const root=ytmActiveRoot();if(!root)return;
            const currentRoute=pageIdentity();if(route!==currentRoute){route=currentRoute;epoch++;ytmCurrentRelease=null;lastReleaseSignature='';}
            const ticket=epoch,id=ytmKey(location.href),provider=PROVIDERS.ytmusic;
            const valid=()=>ticket===epoch && currentRoute===pageIdentity() && root===ytmActiveRoot();
            const emitCurrent=async(record,level)=>{
                const signature=observationSignature(normalizeProviderObservation(provider,level,record));
                if(signature===lastReleaseSignature)return;
                lastReleaseSignature=signature;
                await emit({kind:'release',level,records:[record],ready:true});
            };
            let records=ytmDomCards(root);
            for(const entry of ytmLiveData()){
                const expectedPath=location.pathname==='/search'?'/search':'/browse';
                const expectedBrowse=id || (location.pathname==='/'?'FEmusic_home':location.pathname==='/explore'?'FEmusic_explore':'');
                if(entry.path!==expectedPath || (expectedPath==='/browse' && (!expectedBrowse || entry.params?.browseId!==expectedBrowse)))continue;
                if(location.pathname==='/search' && entry.params?.q!==new URLSearchParams(location.search).get('q'))continue;
                let data=entry.data;try{if(typeof data==='string')data=JSON.parse(data);}catch{continue;}
                const combined=new Map([...records,...ytmSearchRecords(data)].map(record=>[record.key,record]));records=[...combined.values()];
            }
            // Rendered search cards can be virtualized. Log the query, but only a
            // complete background response can establish a unique-result claim.
            if(location.pathname==='/search')records=ytmEvidence(records,ytmGtinQuery(new URLSearchParams(location.search).get('q')),false);
            const changed=records.filter(record=>{const signature=JSON.stringify(record);if(seen.get(record.key)===signature)return false;seen.set(record.key,signature);return true;});
            if(changed.length)await emit({kind:'listing',level:1,records:changed,ready:false});
            if(!valid())return;
            if(!id){await emit({kind:location.pathname==='/search'?'search':'listing',level:1,records,ready:true});return;}
            const album=id.startsWith('video:')?{id,key:id,url:ytmUrl(id),title:'Selected song',artists:[],watchSelection:true,albumBrowseId:ytmSelectedAlbum(root,id.slice(6)),level:1}:ytmDomAlbum(root,id);if(!album?.title)return;
            const cachedRelease=await ytmCachedRelease(album);
            if(!valid())return;
            if(cachedRelease){ytmCurrentRelease=cachedRelease;await emitCurrent(cachedRelease,2);return;}
            const resolved=resolvedWatches.get(id);
            if(resolved && (!album.albumBrowseId || album.albumBrowseId===resolved.browseId)){
                ytmCurrentRelease=resolved;await emitCurrent(resolved,2);return;
            }
            const prior=(await readProviderCacheRecords(provider,[id])).get(id);
            if(!valid())return;
            let current={...prior,...album,identityEvidence:prior?.identityEvidence||[]};
            if(!id.startsWith('video:') && prior?.tracklistComplete && prior.completeness?.watch && (!album.trackCount || prior.trackCount===album.trackCount)){try{current=ytmCanonicalRelease({...prior,coverArt:album.coverArt||prior.coverArt});}catch{current.tracklistComplete=false;}}
            if(id.startsWith('video:'))current=album;
            ytmCurrentRelease=current;
            if(current.completeness?.watch){await emitCurrent(current,2);return;}
            await emitCurrent(current,1);
            if(attempted.has(currentRoute))return;
            let client;try{client=ytmSafeClient(unsafeWindow.ytcfg?.get?.('INNERTUBE_CONTEXT')?.client)||ytmClientContext;}catch{}
            if(!client && (!current.tracklistComplete || id.startsWith('video:')))return;
            attempted.add(currentRoute);
            try{
                const enriched=await ytmEnrich(current,client);
                if(!valid()){await emit({kind:'listing',level:2,records:[enriched],ready:false});return;}
                if(id.startsWith('video:'))resolvedWatches.set(id,enriched);
                ytmCurrentRelease=enriched;await emitCurrent(enriched,2);
            }catch(error){debugWarn('[Harmony: More Provider Lookups]','YTM enrichment unavailable; leaving partial comparison.',error);}
        }
        async function run(){if(running){again=true;return;}running=true;try{await scan();}catch(error){debugWarn('[Harmony: More Provider Lookups]','YTM observation failed',error);}finally{running=false;if(again){again=false;schedule();}}}
        function schedule(){clearTimeout(timer);timer=setTimeout(run,400);}
        const start=()=>{
            schedule();document.addEventListener('yt-navigate-start',()=>{navigating=true;epoch++;ytmCurrentRelease=null;lastReleaseSignature='';});document.addEventListener('yt-navigate-finish',()=>{navigating=false;schedule();});window.addEventListener('popstate',schedule);
            new MutationObserver(mutations=>{if(mutations.some(change=>!change.target.closest?.('#'+PROVIDER_PANEL_ID) && (change.target.closest?.('ytmusic-search-page,ytmusic-browse-response,ytmusic-tabbed-search-results-renderer,ytmusic-player-page')||[...change.addedNodes].some(node=>node.nodeType===1 && node.matches?.('ytmusic-search-page,ytmusic-browse-response,ytmusic-tabbed-search-results-renderer,ytmusic-player-page')))))schedule();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
        };
        if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
    }
    PROVIDERS.ytmusic={
        releaseActions:{types:{artist:[['youtube music',1080]],recording:[['free streaming',268]]},
            entityUrl:(entity,type)=>type!=='recording'||entity.audioVerified||entity.musicVideoType==='MUSIC_VIDEO_TYPE_ATV'?entity.url:'',
            matchesRecord:(url,record)=>[record.key,record.browseId,'playlist:'+record.playlistId,'video:'+record.selectedVideoId].includes(ytmKey(url)),
            identity:(value,type)=>{try{const url=new URL(value);if(type==='artist'&&url.hostname==='music.youtube.com')return url.pathname.match(/^\/(?:channel|browse)\/(UC[^/]+)\/?$/)?.[1]||'';if(type==='recording'){if(['music.youtube.com','www.youtube.com','youtube.com'].includes(url.hostname)&&url.pathname==='/watch')return url.searchParams.get('v')||'';if(url.hostname==='youtu.be')return url.pathname.slice(1);}return '';}catch{return '';}}},
        lookupInputs:{gtinCache:true,gtinBackground:true,barcodeBeforeTextCache:true},
        id:'ytmusic',name:'YouTube Music',harmony:{native:false,want:'full-release'},
        presentation:{backgroundColor:'rgb(255, 0, 0)',color:'#fff',controlForeground:'#fff',controlIconSize:24,iconSize:16,
            icon: {"tag":"svg","attrs":{"viewBox":"0 0 100 100"},"children":[{"tag":"g","attrs":{"fill":"currentColor"},"children":[{"tag":"path","attrs":{"d":"M50,2.5C23.766,2.5,2.5,23.823,2.5,50.126c2.502,63.175,92.507,63.157,95-0.001C97.5,23.823,76.233,2.5,50,2.5z M50,77.399c-15.036,0-27.27-12.233-27.27-27.27c0.74-18.662,14.654-27.134,27.269-27.134c0.001,0,0.001,0,0.002,0c12.616,0.001,26.531,8.473,27.267,27.073C77.27,65.167,65.036,77.399,50,77.399z"}},{"tag":"path","attrs":{"fill-rule":"evenodd","d":"M50.002,26.103c-15.946-0.001-23.704,12.486-24.165,24.088C25.838,63.453,36.677,74.292,50,74.292S74.162,63.453,74.162,50.13C73.705,38.591,65.948,26.105,50.002,26.103z M41.055,52.528c-0.001,2.575,0.001,7.867,0,10.46c0,0,21.802-13.417,21.802-13.417L41.055,37.272V52.528z"}}]}]}},
        preserveIdentityFields:['identityEvidence'],helperTokenInQuery:true,offerHelperReconnect:true,
        isCurrentSite:()=>location.hostname==='music.youtube.com',isSearchPage:()=>location.pathname==='/search',isReleasePage:()=>Boolean(ytmKey(location.href)),
        matchesReleaseUrl:url=>Boolean(ytmKey(url)),getReleaseKey:ytmKey,getArtistUrl:artist=>artist.url||'',
        buildSearchUrl:target=>YTM_ORIGIN+'/search?'+new URLSearchParams({q:[...(target.artists||[]).map(artist=>artist.name||artist),target.title].filter(Boolean).join(' ')}),
        prepareCandidates:ytmCandidates,
        buildManualSearchUrl:(target,record)=>record?.identityEvidence?.some(item=>item.kind==='quoted-gtin-search'&&gtinsMatch(item.gtin,target.gtin))?ytmBarcodeSearchUrl(target.gtin):PROVIDERS.ytmusic.buildSearchUrl(target),
        backgroundSearch:ytmBackgroundSearch,backgroundEnrich:ytmBackgroundEnrich,canAutoAccept:ytmAutoAccept,observePage:ytmObserve,
        getCurrentRelease:()=>{const key=ytmKey(location.href);return (key===ytmCurrentRelease?.key || key==='video:'+ytmCurrentRelease?.selectedVideoId || key==='playlist:'+ytmCurrentRelease?.playlistId)?ytmCurrentRelease:null;},
        canManuallyAccept:record=>fullReleaseIsComplete(record)&&Boolean(record.completeness?.watch)&&record.url?.startsWith(YTM_ORIGIN+'/playlist?list='),
        prepareInjection:ytmCanonicalRelease,
        hasBarcodeEvidence:(target,record)=>record.identityEvidence?.some(item=>item.kind==='quoted-gtin-search'&&gtinsMatch(item.gtin,target.gtin)),
        classifyEvidence:(target,record)=>record.identityEvidence?.some(item=>gtinsMatch(item.gtin,target.gtin))?(ytmAutoAccept(target,record)?'definitive':'navigation'):null,
        getComparisonValues:record=>{
            if(record?.gtin)return {};
            const evidence=new Map();
            for(const item of record?.identityEvidence||[]){
                const key=normalizeComparisonGtin(item.gtin);
                if(!evidence.has(key)||item.uniqueRelease)evidence.set(key,item);
            }
            return evidence.size?{gtin:[...evidence.values()].map(item=>({value:item.gtin,assumption:'Associated through barcode search; not supplied in release metadata'+(item.uniqueRelease?' (one release result)':' (uniqueness not verified)')}))}:{};
        },

    };


    // =========================================================================
    // SOUNDCLOUD MODULE — anonymous acquisition and shared passive normalization
    // =========================================================================
    const SC_LOGO={"tag":"svg","attrs":{"viewBox":"5.12 25.095 52.916 22.972"},"children":[{"tag":"path","attrs":{"fill":"currentColor","d":"M15.835 47.9c-.083-.082-.145-.268-.145-.393 0-.145-.083-1.403-.186-2.807l-.186-2.561.207-4.521c.206-4.604.227-4.769.578-4.769.062 0 .186.041.269.124.124.103.186.681.392 4.562l.248 4.459-.248 2.911c-.145 1.61-.289 2.973-.351 3.034-.145.166-.393.145-.578-.02V47.9zm2.105-.061c-.103-.145-.186-1.012-.33-3.097-.165-2.478-.186-3.18-.103-5.037.041-1.178.124-3.51.186-5.183.062-1.672.124-3.138.145-3.303.083-.537.702-.619.826-.103.021.103.145 2.601.269 5.532l.227 5.348-.227 2.767a293.778 293.778 0 0 0-.227 2.87c0 .164-.269.392-.454.392-.104 0-.227-.083-.31-.206v.02zm2.148.041c-.145-.145-.186-.372-.227-1.445-.042-.702-.104-1.755-.145-2.333-.124-1.465-.104-3.365.041-7.887.083-2.146.145-4.314.145-4.851.021-1.094.104-1.424.393-1.507.351-.083.619.165.619.599 0 .207.103 2.89.207 5.946l.207 5.554-.207 2.787c-.104 1.527-.207 2.828-.207 2.891 0 .164-.269.392-.475.392-.103 0-.248-.083-.351-.165v.019zm2.147 0c-.103-.124-.165-.372-.207-.764-.31-4.707-.31-5.038-.165-9.951.186-6.771.227-7.412.392-7.577s.62-.165.764 0c.083.083.145 1.28.248 3.964.248 7.494.269 8.691.103 11.148-.186 2.787-.206 3.034-.392 3.199-.186.186-.516.166-.723-.041l-.02.022zm2.147-.021c-.103-.104-.186-.33-.186-.475s-.062-1.383-.145-2.746c-.145-2.291-.145-2.932 0-8.485.165-6.441.165-6.338.64-6.441.413-.083.682.268.682.908 0 .289.041 1.796.083 3.324.041 1.528.103 3.86.145 5.183.021 1.301.062 2.436.083 2.498.021.062-.042 1.362-.145 2.89a185.27 185.27 0 0 0-.186 2.974c0 .247-.33.578-.619.578a.569.569 0 0 1-.392-.207h.04zm2.209.021c-.186-.186-.207-.413-.392-3.716-.103-1.92-.083-3.943.103-10.488.104-3.509.104-3.571.661-3.571.186 0 .372.062.475.186.186.186.186.33.268 3.344.021.949.104 3.262.145 5.12.083 3.034.083 3.675-.083 6.173-.165 2.684-.186 2.787-.392 2.952-.269.206-.599.206-.826 0h.041zm2.188 0c-.124-.124-.186-.351-.227-.764-.145-1.59-.248-5.533-.207-7.866.021-1.445.083-3.654.104-4.955.103-5.223.145-6.048.33-6.234.227-.227.681-.227.888 0 .227.227.248.888.454 10.963.062 3.035-.145 8.361-.351 8.732-.186.352-.723.413-1.012.124h.021zm2.251-.021a.77.77 0 0 1-.289-.475c-.021-.166-.104-1.508-.186-2.994-.103-2.126-.124-3.406-.062-6.008.042-1.816.104-4.83.145-6.688.062-4.253.104-4.666.351-4.914.269-.248.661-.227.95.041.207.207.227.289.248 1.342 0 .619.021 1.238.041 1.362s.042 1.879.083 3.901c.042 2.023.083 3.696.104 3.717.103.165.021 6.152-.104 8.01a104.788 104.788 0 0 0-.145 2.271c0 .227-.413.619-.681.619-.125.002-.332-.08-.455-.184zm2.002-.041l-.228-.228V26.244l.248-.186c.289-.227 1.383-.578 2.478-.805 1.177-.227 3.097-.207 4.315.041 4.871 1.012 8.34 4.749 9.125 9.827l.062.33.806-.227c.681-.186.929-.227 1.816-.186 1.26.062 1.321.062 2.146.371 3.635 1.383 5.285 5.574 3.531 9.043-.806 1.61-1.962 2.621-3.717 3.262l-.66.248-9.827.021-9.827.021-.268-.186zm-19.365-.083c-.041-.103-.165-1.466-.289-3.015-.207-2.725-.207-2.849-.062-4.582.083-.971.166-2.168.207-2.643.062-.867.207-1.281.434-1.281.289 0 .372.331.62 2.953l.248 2.684-.248 2.85c-.124 1.568-.269 2.932-.31 3.055-.041.145-.145.207-.31.207s-.248-.062-.31-.207l.02-.021zm-2.064.042c-.021-.042-.165-1.363-.289-2.932l-.248-2.85.248-2.952c.124-1.631.289-3.015.331-3.076.124-.145.31-.145.434 0 .062.062.227 1.425.372 3.056l.268 2.932-.268 2.849c-.145 1.569-.289 2.891-.31 2.952-.041.124-.475.166-.537.041v-.02zm-2.044-.227c-.041-.062-.186-1.321-.31-2.808l-.248-2.705.227-2.56c.124-1.403.248-2.746.268-2.952.062-.413.248-.578.434-.393.062.062.227 1.28.393 2.911l.289 2.808-.269 2.705c-.145 1.486-.31 2.787-.351 2.91-.103.228-.31.269-.434.104v-.02zm-2.085-.867c-.021-.083-.165-1.218-.289-2.498l-.248-2.333.268-2.374c.248-2.271.289-2.374.475-2.415.227-.042.206-.145.578 2.725l.268 2.146-.268 2.251c-.145 1.239-.31 2.333-.351 2.456-.104.248-.331.27-.393.042h-.04zm-1.92-1.735a27.33 27.33 0 0 1-.248-1.548l-.186-1.404.207-1.486c.103-.826.248-1.549.289-1.61.206-.248.351.145.557 1.61l.227 1.486-.227 1.486c-.124.826-.289 1.527-.351 1.569-.165.103-.227.083-.289-.083l.021-.02z"}}]};
    const SC_ORIGIN='https://soundcloud.com', SC_API='https://api-v2.soundcloud.com';
    const SC_CLIENT_KEY='hmpl-soundcloud-client-v1'; // Deliberately outside release-cache keys.
    let scClientPending=null,scCurrent=null,scCurrentRoute='';
    const scKey=value=>{try{const u=new URL(value);return u.origin===SC_ORIGIN && (/^[\/]([^/]+)\/sets\/[^/]+\/?$/.test(u.pathname)||(/^\/[^/]+\/[^/]+\/?$/.test(u.pathname)&&!/^\/(discover|search|you|charts|settings|stations|upload)\//.test(u.pathname)&&!/^\/[^/]+\/(tracks|albums|sets|reposts|likes|popular-tracks|followers|following)\/?$/.test(u.pathname)))?u.origin+u.pathname.replace(/\/$/,''):'';}catch{return '';}};
    const scTextQuery=target=>[...(target.artists||[]).map(a=>a.name||a),target.title].filter(Boolean).join(' ');
    const scSearchUrl=target=>SC_ORIGIN+'/search?'+new URLSearchParams({q:scTextQuery(target)});
    function scHydration(html){
        const match=/window\.__sc_hydration\s*=\s*/.exec(html);if(!match)return [];
        const start=match.index+match[0].length;if(html[start]!=='[')return [];
        let depth=0,quoted=false,escape=false;
        for(let i=start;i<html.length;i++){
            const c=html[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
            if(c==='"')quoted=true;else if(c==='[')depth++;else if(c===']'&&--depth===0)return JSON.parse(html.slice(start,i+1));
        }return [];
    }
    function scClientFrom(hydration,version){
        const id=hydration?.find(item=>item.hydratable==='apiClient')?.data?.id;
        return typeof id==='string'&&/^[a-zA-Z0-9_-]{16,128}$/.test(id)?{id,...(/^\d+$/.test(String(version||''))?{version:String(version)}:{})}:null;
    }
    async function scSaveClient(client){
        if(client){const saved=await GM_getValue(SC_CLIENT_KEY,null);if(JSON.stringify(saved)!==JSON.stringify(client))await GM_setValue(SC_CLIENT_KEY,client);}
        return client;
    }
    function scRequest(url,signal){
        const origin=new URL(url).origin;if(![SC_ORIGIN,SC_API].includes(origin))return Promise.reject(new Error('Invalid SoundCloud request origin'));
        return new Promise((resolve,reject)=>providerHttp(signal,{method:'GET',url,anonymous:true,timeout:25000,
            onload:r=>{if(r.status!==200){const e=new Error('SoundCloud HTTP '+r.status);e.status=r.status;reject(e);return;}if(new URL(r.finalUrl||url).origin!==origin){reject(new Error('Unexpected SoundCloud redirect'));return;}resolve(r.responseText);},
            onerror:()=>reject(new Error('SoundCloud network error')),ontimeout:()=>reject(new Error('SoundCloud timeout'))}));
    }
    async function scDocument(url,signal){
        const html=await scRequest(url,signal),hydration=scHydration(html);
        const version=/window\.__sc_version\s*=\s*["']?(\d+)/.exec(html)?.[1];
        await scSaveClient(scClientFrom(hydration,version));
        return {html,hydration};
    }
    async function scClient(refresh=false,signal){
        if(!refresh){const saved=await GM_getValue(SC_CLIENT_KEY,null);if(saved?.id)return saved;}
        if(signal){checkAcquisition(signal);const {hydration,html}=await scDocument(SC_ORIGIN+'/',signal);const client=scClientFrom(hydration,/window\.__sc_version\s*=\s*["']?(\d+)/.exec(html)?.[1]);if(!client)throw new Error('SoundCloud client configuration unavailable');return client;}
        if(!scClientPending)scClientPending=(async()=>{const {hydration,html}=await scDocument(SC_ORIGIN+'/');const client=scClientFrom(hydration,/window\.__sc_version\s*=\s*["']?(\d+)/.exec(html)?.[1]);if(!client)throw new Error('SoundCloud client configuration unavailable');return client;})().finally(()=>{scClientPending=null;});
        return scClientPending;
    }
    async function scApi(path,params={},signal){
        let client=await scClient(false,signal);
        for(let attempt=0;attempt<2;attempt++){
            const url=new URL(path,SC_API);if(url.origin!==SC_API)throw new Error('Invalid SoundCloud API path');
            for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
            url.searchParams.set('client_id',client.id);url.searchParams.set('app_locale','en');if(client.version)url.searchParams.set('app_version',client.version);
            try{return JSON.parse(await scRequest(url.href,signal));}catch(error){if(attempt===0&&[401,403].includes(error.status)){client=await scClient(true,signal);continue;}throw error;}
        }
    }
    function scMetadata(data){
        const publisher=data.publisher_metadata||{};
        const result={};
        for(const key of ['album_title','writer_composer','publisher','p_line','c_line','p_line_for_display','c_line_for_display','upc_or_ean','explicit','contains_music']){
            const value=publisher[key];if(typeof value==='string'||typeof value==='boolean'||typeof value==='number')result[key]=value;
        }
        const number=value=>value!=null&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
        return {publisherMetadata:result,albumTitle:clean(publisher.album_title),writerComposer:clean(publisher.writer_composer||data.writer_composer),
            publisher:clean(publisher.publisher),labelName:clean(data.label_name),pLine:clean(publisher.p_line||publisher.p_line_for_display),cLine:clean(publisher.c_line||publisher.c_line_for_display),
            upc:clean(publisher.upc_or_ean),explicit:typeof publisher.explicit==='boolean'?publisher.explicit:null,
            containsMusic:typeof publisher.contains_music==='boolean'?publisher.contains_music:typeof data.contains_music==='boolean'?data.contains_music:null,
            bpm:number(data.bpm),keySignature:clean(data.key_signature),tags:clean(data.tag_list),genre:clean(data.genre),
            duration:number(data.duration),fullDuration:number(data.full_duration),isPreview:data.policy==='SNIP'&&Number(data.full_duration)>Number(data.duration)&&Number(data.duration)>0,
            releasedAt:clean(data.release_date),publishedAt:clean(data.published_at),createdAt:clean(data.created_at),displayDate:clean(data.display_date),lastModified:clean(data.last_modified)};
    }
    function scReleaseEvidence(record){
        const valid=value=>{const digits=clean(value).replace(/[\s-]/g,'');return /^(?:\d{8}|\d{12,14})$/.test(digits)?digits:'';};
        const own=valid(record.upc);
        record.comparisonValues??={};delete record.comparisonValues.gtin;
        record.gtin=own;
        if(!own&&record.tracklistComplete&&record.tracks.length){
            const codes=record.tracks.map(track=>valid(track.upc));
            if(codes.every(Boolean)&&codes.every(code=>gtinsMatch(code,codes[0])))record.comparisonValues.gtin=[{value:codes[0],...(record.trackCount===1?{}:{assumption:'Common barcode supplied by every track; not a playlist-level barcode'})}];
        }
        record.copyright=[record.cLine,record.pLine].filter(Boolean).join(' / ');
        return record;
    }
    function scTrack(track,index){
        const artist=clean(track.publisher_metadata?.artist||track.user?.username);
        const length=Number(track.full_duration)>0?Number(track.full_duration):Number(track.duration);
        return {...scMetadata(track),...(track.policy==='SNIP'&&Number(track.full_duration)>Number(track.duration)&&Number(track.duration)>0?{comparisonValues:{length:{value:injectionDuration(length),notifier:'Preview available; comparison uses full recording duration'}}}:{}),id:String(track.id||''),number:String(index+1),title:clean(track.title),artists:artist?[{name:artist,...(artist===track.user?.username&&track.user?.permalink_url?{url:track.user.permalink_url}:{})}]:[],
            length:Number.isFinite(length)&&length>0?Math.round(length):null,url:injectionUrl(track.permalink_url),isrc:clean(track.publisher_metadata?.isrc).replace(/[^a-z0-9]/gi,'').toUpperCase()};
    }
    function scCompleteness(record){
        record.tracklistComplete=record.trackCount>0&&record.tracks.length===record.trackCount&&new Set(record.tracks.map(t=>t.id)).size===record.trackCount&&record.tracks.every(t=>/^\d+$/.test(t.id)&&t.title&&t.artists.length&&t.length>0);
        record.level=record.tracklistComplete&&record.title&&record.artists.length?2:1;
        record.completeness={releaseIdentity:Boolean(record.title&&record.artists.length),tracklist:record.tracklistComplete};return scReleaseEvidence(record);
    }
    function scPlaylist(data){
        const url=scKey(data?.permalink_url);if(data?.kind!=='playlist'||!url||data.public===false||data.sharing==='private'||!/^\d+$/.test(String(data.id)))return null;
        const uploader={id:String(data.user?.id||data.user_id||''),name:clean(data.user?.username),url:injectionUrl(data.user?.permalink_url)};
        const record={...scMetadata(data),provider:'soundcloud',level:2,key:url,id:String(data.id),url,title:clean(data.title),artists:uploader.name?[{name:uploader.name,url:uploader.url}]:[],uploader,
            coverArt:injectionUrl(data.artwork_url||(data.tracks||[]).find(t=>t.artwork_url)?.artwork_url),
            trackCount:Number(data.track_count)||0,tracks:(data.tracks||[]).map(scTrack),
            date:normalizeDate(data.release_date),isAlbum:data.is_album===true,
            publishedAt:clean(data.published_at),createdAt:clean(data.created_at),displayDate:clean(data.display_date),
            ...(data.label_name?{labels:[{name:clean(data.label_name)}]}:{}),genre:clean(data.genre),
            externalLinks:[{url,types:['free streaming']}],
            comparisonValues:{date:[['release_date','Release date'],['published_at','Publication date'],['created_at','Creation date'],['display_date','SoundCloud display date'],['last_modified','Last modified date']].map(([key,label])=>({value:normalizeDate(data[key]),notifier:key+': '+label})).filter(x=>x.value)}};
        return scCompleteness(record);
    }
    function scEntity(data){
        if(data?.kind!=='track')return scPlaylist(data);
        const url=scKey(data.permalink_url);if(!url||data.public===false||data.sharing==='private')return null;
        const track=scTrack(data,0),metadata=scMetadata(data);
        const record={...metadata,provider:'soundcloud',id:String(data.id),key:url,url,title:clean(data.title),artists:track.artists,uploader:{id:String(data.user?.id||''),name:clean(data.user?.username),url:injectionUrl(data.user?.permalink_url)},entityKind:'track',singleStatus:'unverified',tracks:[track],trackCount:1,upc:'',date:normalizeDate(data.release_date),coverArt:injectionUrl(data.artwork_url),labels:data.label_name?[{name:clean(data.label_name)}]:[],externalLinks:[{url,types:['free streaming']}],comparisonValues:{date:[['release_date','Release date'],['published_at','Publication date'],['created_at','Creation date'],['display_date','Display date'],['last_modified','Last modified']].map(([key,label])=>({value:normalizeDate(data[key]),notifier:key+': '+label})).filter(x=>x.value)}};
        return scCompleteness(record);
    }
    async function scRetain(records){
        const old=await readProviderCacheRecords(PROVIDERS.soundcloud,records.map(r=>r.key));
        return records.map(record=>{const prior=old.get(record.key);if(!record.tracks||!prior?.tracks)return record;
            // Fill stubs by stable track ID; preserve fresh ordering and count.
            const tracks=new Map(prior.tracks.map(t=>[t.id,t]));
            record.tracks=record.tracks.map(t=>{const p=tracks.get(t.id);if(!p)return t;const retained={...p,...Object.fromEntries(Object.entries(t).filter(([,value])=>value!=null&&value!==''))};retained.publisherMetadata={...p.publisherMetadata,...t.publisherMetadata};return {...retained,title:t.title||p.title,artists:t.artists.length?t.artists:p.artists,length:t.length||p.length,isrc:t.isrc||p.isrc,url:t.url||p.url};});
            return scCompleteness(record);
        });
    }
    function scSearchDocument(doc){
        const records=new Map();
        for(const link of doc.querySelectorAll('a[href*="/sets/"]')){
            const url=scKey(new URL(link.getAttribute('href'),SC_ORIGIN).href),title=clean(link.textContent);if(!url||!title)continue;
            const item=link.closest('article,li')||link.parentElement;
            const artist=[...item.querySelectorAll('a[href]')].find(a=>{try{return /^\/[^/]+\/?$/.test(new URL(a.getAttribute('href'),SC_ORIGIN).pathname);}catch{return false;}});
            if(!records.has(url))records.set(url,{provider:'soundcloud',level:1,key:url,url,title,artists:artist?[{name:clean(artist.textContent),url:new URL(artist.getAttribute('href'),SC_ORIGIN).href}]:[]});
        }return [...records.values()];
    }
    async function scBackgroundSearch({target,observe,signal}){
        const url=scSearchUrl(target);
        try{
            if(scKey(target.url))return {status:'candidate',record:{level:1,key:scKey(target.url),url:scKey(target.url)}};
            const response=await scApi('/search',{q:scTextQuery(target),facet:'model',limit:'20',offset:'0',linked_partitioning:'1'},signal);
            const records=await scRetain((response.collection||[]).map(scEntity).filter(Boolean));
            for(const level of [1,2])await observeProviderBatch(observe,level,records.filter(r=>r.level===level));
            const provider=PROVIDERS.soundcloud,record=[...records].sort((a,b)=>Number(a.entityKind==='track')-Number(b.entityKind==='track')).find(record=>classifyProviderMatch(provider,target,record));
            debugTrace('SoundCloud: playlist candidates evaluated',null,{playlists:records.length,complete:records.filter(r=>r.tracklistComplete).length,candidate:record?.id});
            return record?{status:'candidate',record}:{status:'no-match'};
        }catch(error){debugWarn('SoundCloud background search unavailable',error);return {status:'interaction-required',url,reason:'search-unavailable'};}
    }
    async function scBackgroundEnrich({record,signal}){
        const key=scKey(record.url);
        const cached=(await readProviderCacheRecords(PROVIDERS.soundcloud,[key])).get(key);
        if(cached&&fullReleaseIsComplete(cached)&&(!(record.trackCount>0)||record.trackCount===cached.trackCount))return {status:'candidate',record:cached};
        if(fullReleaseIsComplete(record))return {status:'candidate',record};
        if(cached&&!record.id)record=cached;
        try{
            if((!record.id||record.entityKind==='track')&&(await GM_getValue(SC_CLIENT_KEY,null))?.id){
                const resolved=scEntity(await scApi('/resolve',{url:record.url},signal));
                if(!resolved||resolved.key!==scKey(record.url))throw new Error('SoundCloud resolved entity is not the requested playlist');
                record=(await scRetain([resolved]))[0];
            }
            if(!record.id||!(await GM_getValue(SC_CLIENT_KEY,null))?.id){
                const {hydration}=await scDocument(record.url,signal);
                let data=hydration.find(x=>['playlist','track'].includes(x.data?.kind)&&scKey(x.data?.permalink_url)===scKey(record.url))?.data;
                if(!data)data=await scApi('/resolve',{url:record.url},signal);
                const parsed=scEntity(data);if(!parsed)throw new Error('SoundCloud playlist hydration unavailable');record=(await scRetain([parsed]))[0];
                if(fullReleaseIsComplete(record))return {status:'candidate',record};
            }
            if(record.title&&record.artists?.length&&record.trackCount>0&&record.tracks?.length===record.trackCount&&record.tracks.every(track=>/^\d+$/.test(track.id))){
                return {status:'candidate',record:await scFillTracks(record,signal)};
            }
            if(record.entityKind==='track')return {status:'candidate',record};
            const response=await scApi('/playlists/'+encodeURIComponent(record.id),{},signal);
            const parsed=scPlaylist(response);if(!parsed||parsed.id!==String(record.id)||parsed.key!==record.key)throw new Error('SoundCloud playlist identity mismatch');
            record=(await scRetain([parsed]))[0];
            record=await scFillTracks(record,signal);
            return {status:'candidate',record};
        }catch(error){debugWarn('SoundCloud enrichment unavailable',error);return {status:'interaction-required',url:record.url,reason:'enrichment-unavailable'};}
    }
    async function scFillTracks(record,signal){
        const missing=record.tracks.filter(t=>!t.title||!t.artists?.length||!(t.length>0)).map(t=>t.id).filter(id=>/^\d+$/.test(id));
        const resolved=new Map();
        for(let start=0;start<missing.length;start+=50){
            const response=await scApi('/tracks',{ids:missing.slice(start,start+50).join(',')},signal);
            for(const raw of Array.isArray(response)?response:response.collection||[])if(missing.includes(String(raw.id)))resolved.set(String(raw.id),raw);
        }
        record={...record,tracks:record.tracks.map((track,index)=>resolved.has(track.id)?scTrack(resolved.get(track.id),index):track)};
        return scCompleteness(record);
    }
    function scParentUrls(doc=document,href=location.href){
        const page=new URL(href),context=page.searchParams.get('in');
        const setUrl=value=>{const key=scKey(value);return key&&new URL(key).pathname.split('/')[2]==='sets'?key:'';};
        const explicit=context&&setUrl(new URL(context.replace(/^\//,''),SC_ORIGIN+'/').href);
        if(explicit)return [explicit];
        const urls=[];
        for(const section of doc.querySelectorAll('.sidebarModule')){
            if(clean(section.querySelector('.sidebarHeader__actualTitle')?.textContent).toLowerCase()!=='in albums'||section.hidden||section.style.display==='none')continue;
            for(const link of section.querySelectorAll('a[href]')){
                const url=setUrl(new URL(link.getAttribute('href'),SC_ORIGIN).href);
                if(url&&!urls.includes(url))urls.push(url);
            }
        }
        return urls;
    }
    function scObserve(emit){
        let queue=Promise.resolve(),timer,lastUrl='',selectedSignature='',documentAttempt='',enrichmentAttempt='',seen=new Map(),parentAttempts=new Set(),parent=null,viewedTrack=null;
        const enqueue=task=>{queue=queue.then(task).catch(error=>debugWarn('SoundCloud passive observation failed',error));};
        const publish=async (records,searchResults=false)=>{
            records=await scRetain(records);const fresh=records.filter(r=>{const signature=JSON.stringify(r);if(seen.get(r.key)===signature)return false;seen.set(r.key,signature);return true;});
            const listing=fresh.filter(r=>r.key!==scKey(location.href));
            if(listing.length)await emit({kind:'listing',level:2,records:listing,ready:false});
            const selected=records.find(r=>r.key===scKey(location.href));
            if(selected){
                if(selected.entityKind==='track')viewedTrack=selected;
                const current=parent||selected;scCurrent=current;scCurrentRoute=location.pathname+location.search;
                const signature=JSON.stringify(current);if(signature!==selectedSignature){selectedSignature=signature;await emit({kind:'release',level:current.level,records:[current],ready:true});}
            }
            else if(searchResults&&location.pathname==='/search'&&fresh.length)await emit({kind:'search',level:2,records,ready:true});
        };
        const receive=data=>enqueue(()=>publish((Array.isArray(data?.collection)?data.collection:[data]).map(scEntity).filter(Boolean),true));
        // Observe only public playlist/search responses already requested by the site.
        // Preserve original results and never inspect request credentials or playback/history.
        const relevant=value=>{try{const u=new URL(value,SC_ORIGIN);return u.origin===SC_API&&(/^\/search(?:\/playlists)?$/.test(u.pathname)||/^\/(?:playlists|tracks)\/\d+$/.test(u.pathname)||u.pathname==='/resolve');}catch{return false;}};
        try{
            const original=unsafeWindow.fetch;
            if(original)unsafeWindow.fetch=function(...args){const promise=Reflect.apply(original,this,args);if(relevant(typeof args[0]==='string'?args[0]:args[0]?.url))promise.then(response=>{if(response.ok)response.clone().json().then(receive).catch(()=>{});}).catch(()=>{});return promise;};
            const proto=unsafeWindow.XMLHttpRequest?.prototype,urls=new WeakMap();
            if(proto){const open=proto.open,send=proto.send;proto.open=function(method,url,...args){urls.set(this,url);return Reflect.apply(open,this,[method,url,...args]);};proto.send=function(...args){if(relevant(urls.get(this)))this.addEventListener('load',()=>{try{if(this.status===200)receive(this.responseType==='json'?this.response:JSON.parse(this.responseText));}catch{}},{once:true});return Reflect.apply(send,this,args);};}
        }catch(error){debugWarn('SoundCloud passive response hooks unavailable',error);}
        const scan=async()=>{
            const route=location.pathname+location.search;
            if(route!==lastUrl){lastUrl=route;scCurrent=null;scCurrentRoute='';selectedSignature='';documentAttempt='';enrichmentAttempt='';seen=new Map();parentAttempts=new Set();parent=null;viewedTrack=null;}
            let hydration;try{hydration=unsafeWindow.__sc_hydration;}catch{}
            if(!Array.isArray(hydration))hydration=scHydration(document.documentElement.outerHTML);
            await scSaveClient(scClientFrom(hydration,unsafeWindow.__sc_version));
            const records=hydration.filter(x=>['playlist','track'].includes(x.data?.kind)).map(x=>scEntity(x.data)).filter(Boolean);
            if(records.length)await publish(records);
            const viewed=scKey(location.href);
            if(viewed&&!scCurrent){
                const cached=(await readProviderCacheRecords(PROVIDERS.soundcloud,[viewed])).get(viewed);
                if(location.pathname+location.search!==route)return;
                if(cached)await publish([cached]);
            }
            if(viewed&&!scCurrent&&documentAttempt!==viewed){
                documentAttempt=viewed;
                debugTrace('SoundCloud: acquiring current playlist document',null,{url:viewed});
                try{
                    const {hydration:currentHydration}=await scDocument(viewed);
                    if(scKey(location.href)!==viewed)return;
                    const current=currentHydration.filter(x=>['playlist','track'].includes(x.data?.kind)).map(x=>scEntity(x.data)).filter(r=>r?.key===viewed);
                    if(current.length)await publish(current);
                    else {const resolved=scEntity(await scApi('/resolve',{url:viewed}));if(resolved?.key===viewed&&scKey(location.href)===viewed)await publish([resolved]);}
                }catch(error){debugWarn('SoundCloud current playlist acquisition failed',error);}
            }
            if(viewed&&scCurrent&&!scCurrent.tracklistComplete&&enrichmentAttempt!==viewed){
                enrichmentAttempt=viewed;
                const result=await scBackgroundEnrich({record:scCurrent});
                if(scKey(location.href)===viewed&&result.record)await publish([result.record]);
            }
            // Only website context changes the helper's selected release; background search stays unchanged.
            if(viewedTrack&&viewedTrack.key===viewed&&!parent){
                for(const url of scParentUrls()){
                    if(parentAttempts.has(url))continue;
                    parentAttempts.add(url);
                    const cached=(await readProviderCacheRecords(PROVIDERS.soundcloud,[url])).get(url);
                    const candidate=cached&&fullReleaseIsComplete(cached)?cached:(await scBackgroundEnrich({record:cached||{url}})).record;
                    if(location.pathname+location.search!==route)return;
                    if(!candidate||candidate.key!==url||!candidate.tracks?.some(track=>String(track.id)===String(viewedTrack.id)))continue;
                    parent=candidate;
                    // Cache the set under its own identity, never under the track's key.
                    await publish([candidate]);
                    await publish([viewedTrack]);
                    break;
                }
            }
            if(location.pathname==='/search'){const cards=scSearchDocument(document);if(cards.length)await emit({kind:'search',level:1,records:cards,ready:true});}
        };
        const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>enqueue(scan),250);};
        new MutationObserver(changes=>{if(changes.some(change=>!change.target.closest?.('#'+PROVIDER_PANEL_ID)))schedule();}).observe(document.documentElement,{subtree:true,childList:true});
        window.addEventListener('popstate',schedule);document.addEventListener('DOMContentLoaded',schedule,{once:true});
        // Detect SPA URL changes even when the page does not emit popstate.
        setInterval(()=>{if(location.pathname+location.search!==lastUrl)schedule();},500);schedule();
    }
    PROVIDERS.soundcloud={
        releaseActions:{types:{artist:[['soundcloud',291]],label:[['soundcloud',290]],recording:[['free streaming',268]]},
            identity:(value,type)=>{try{const url=new URL(value);if(!/^(www\.)?soundcloud\.com$/.test(url.hostname))return '';const path=url.pathname.replace(/\/$/,'');return (type==='recording'?/^\/[^/]+\/(?!sets$)[^/]+$/.test(path):/^\/[^/]+$/.test(path))?path:'';}catch{return '';}}},id:'soundcloud',name:'SoundCloud',isCandidateEligible:(target,record)=>record.entityKind!=='track'||!(Number(target.trackCount)>1),formatProviderLabel:release=>clean(release.key||release.url).replace('https://soundcloud.com/',''),harmony:{native:false,want:'full-release'},lookupInputs:{},
        presentation:{backgroundColor:'rgb(255, 64, 0)',color:'#fff',controlForeground:'#fff',controlIconSize:24,iconSize:16,icon:SC_LOGO},
        isCurrentSite:()=>location.hostname==='soundcloud.com',isSearchPage:()=>location.pathname==='/search',isReleasePage:()=>Boolean(scKey(location.href)),
        matchesReleaseUrl:value=>Boolean(scKey(value)),getReleaseKey:scKey,buildSearchUrl:scSearchUrl,
        backgroundSearch:scBackgroundSearch,backgroundEnrich:scBackgroundEnrich,observePage:scObserve,
        requireUserConfirmation:true,getCurrentRelease:()=>scCurrentRoute===location.pathname+location.search?scCurrent:null,canManuallyAccept:fullReleaseIsComplete,
        };


    // =========================================================================
    // 7DIGITAL — regional HTML acquisition and shared passive parsers
    // =========================================================================
    const SD_STORES={AU:['www.zdigital.com.au','d/m/y'],BE:['nl-be.7digital.com','d.m.y'],CA:['ca.7digital.com','y-m-d'],DE:['de.7digital.com','d.m.y'],ES:['es.7digital.com','d/m/y'],FI:['fi.7digital.com','d.m.y'],FR:['fr.7digital.com','d/m/y'],IE:['ie.7digital.com','d/m/y'],IT:['it.7digital.com','d/m/y'],LU:['lu.7digital.com','d/m/y'],NL:['nl.7digital.com','d-m-y'],NZ:['nz.7digital.com','d/m/y'],NO:['no.7digital.com','d.m.y'],AT:['at.7digital.com','d.m.y'],PT:['pt.7digital.com','d/m/y'],CH:['de-ch.7digital.com','d.m.y'],SG:['sg.7digital.com','y/m/d'],SE:['se.7digital.com','y-m-d'],GB:['uk.7digital.com','d/m/y'],US:['us.7digital.com','m/d/y']};
    let sdCurrent=null;
    function sdCountry(url){try{const host=new URL(url).hostname;return Object.keys(SD_STORES).find(code=>SD_STORES[code][0]===host)||'';}catch{return '';}}
    function sdRegion(target={}){const direct=sdCountry(target.url);if(direct)return direct;const regions=Array.isArray(target.regions)?target.regions:String(target.regions||'').split(',');return regions.map(code=>clean(code).toUpperCase().replace(/^UK$/,'GB')).find(code=>SD_STORES[code])||'GB';}
    function sdUrl(value,base=location.href){try{const url=new URL(value,base);if(!sdCountry(url.href)||!/^\/artist\/[^/]+\/release\/[^/]+-\d+\/?$/.test(url.pathname))return '';return url.origin+url.pathname.replace(/\/$/,'');}catch{return '';}}
    function sdKey(value){const url=sdUrl(value);return url?sdCountry(url)+':'+url.match(/-(\d+)$/)[1]:'';}
    function sdSearch(target){const url=new URL('https://'+SD_STORES[sdRegion(target)][0]+'/search');url.searchParams.set('q',[...(target.artists||[]).map(a=>a.name||a),target.title].filter(Boolean).join(' '));url.searchParams.set('fallback','true');return url.href;}
    function sdDate(raw,country){const format=SD_STORES[country]?.[1],parts=clean(raw).split(/[./-]/);if(!format||parts.length!==3||parts.some(p=>!/^\d+$/.test(p)))return '';const order=format.split(/[./-]/),values=Object.fromEntries(order.map((key,i)=>[key,Number(parts[i])]));const {y,m,d}=values;if(y<1000||m<1||m>12||d<1||d>31)return '';const date=new Date(Date.UTC(y,m-1,d));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`:'';}
    function sdBlocked(doc){return Boolean(doc.querySelector('#captcha-container,script[src*="captcha.awswaf.com"],script[src*="token.awswaf.com"]')||/human verification/i.test(doc.title));}
    function sdCards(doc,base){return [...doc.querySelectorAll('.packshot')].flatMap(card=>{const name=card.querySelector('.packshot-release-name'),url=sdUrl(name?.closest('a')?.getAttribute('href'),base);if(!url||!name)return [];const artist=card.querySelector('.packshot-artist-name'),image=card.querySelector('.packshot-image img');const formats=[...card.querySelectorAll('.coverart-package-info .is-format')].map(node=>clean(node.textContent).toUpperCase());return [sdDecorate({formats,provider:'sevendigital',level:1,key:sdKey(url),id:url.match(/-(\d+)$/)[1],url,country:sdCountry(url),title:clean(name.textContent),artists:artist?[{name:clean(artist.textContent),url:artist.closest('a')?new URL(artist.closest('a').getAttribute('href'),base).href:''}]:[],year:clean(card.querySelector('.packshot-release-date')?.textContent),coverArt:image?new URL(image.getAttribute('data-src')||image.getAttribute('src'),base).href:''})];});}
    function sdRelease(doc,base){
        const url=sdUrl(base),section=doc.querySelector('section.release'),info=section?.querySelector('.release-info');if(!url||!info)return null;
        const id=info.getAttribute('data-releaseid');if(id!==url.match(/-(\d+)$/)[1])return null;
        const artists=[...info.querySelectorAll('.release-info-artist a')].map(a=>({name:clean(a.textContent),url:new URL(a.getAttribute('href'),url).href}));
        const tracks=[...section.querySelectorAll('tr.release-track')].map((row,index)=>{const raw=row.querySelector('[itemprop="duration"]')?.getAttribute('content')||'',match=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(raw);const credits=[...row.querySelectorAll('.release-track-list-additional a')].map(a=>({name:clean(a.textContent),url:new URL(a.getAttribute('href'),url).href}));return {id:row.getAttribute('data-trackid'),number:clean(row.querySelector('.release-track-preview-text')?.textContent)||String(index+1),title:clean(row.querySelector('.release-track-name [itemprop="name"]')?.getAttribute('content')||row.querySelector('.release-track-name > p')?.textContent),artists:credits.length?credits:artists,length:match?(Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0))*1000:null,url};});
        const country=sdCountry(url),rawDate=clean(info.querySelector('.release-date-info .release-data-info')?.textContent),label=clean(info.querySelector('.release-label-info .release-data-info')?.textContent),image=info.querySelector('[itemprop="image"]');
        const copyright=[...section.querySelectorAll('dl.release-data dd')].map(n=>clean(n.textContent)).filter(text=>/^[℗©]/.test(text));
        const record={provider:'sevendigital',id,key:sdKey(url),url,country,title:clean(info.querySelector('.release-info-title')?.textContent),artists,tracks,trackCount:tracks.length,rawDate,date:sdDate(rawDate,country),coverArt:image?new URL(image.getAttribute('src'),url).href:'',labels:label?[{name:label}]:[],copyright:copyright.join(' / '),genres:[...section.querySelectorAll('dl.release-data a[href^="/genre/"]')].map(n=>clean(n.textContent)),formats:[...info.querySelectorAll('.package-info-type')].map(n=>clean(n.textContent)),externalLinks:[{url,types:['purchase for download']}]};
        record.tracklistComplete=Boolean(record.title&&artists.length&&tracks.length&&new Set(tracks.map(t=>t.id)).size===tracks.length&&tracks.every(t=>/^\d+$/.test(t.id||'')&&t.title&&t.artists.length&&t.length>0));record.level=record.tracklistComplete?2:1;return sdDecorate(record);
    }
    function sdDocument(url,partial=false,signal){return new Promise((resolve,reject)=>{if(!sdCountry(url))return reject(new Error('Unsupported 7digital storefront'));providerHttp(signal,{method:'GET',url,headers:partial?{'X-Requested-With':'XMLHttpRequest'}:{},timeout:25000,onload:response=>{try{const doc=new DOMParser().parseFromString(response.responseText||'','text/html');if(sdBlocked(doc))return reject(Object.assign(new Error('7digital requires human verification'),{interactionUrl:url,reason:'captcha'}));if(response.status!==200)throw new Error('7digital HTTP '+response.status);if(sdCountry(response.finalUrl||url)!==sdCountry(url))throw new Error('7digital redirected to a different storefront');resolve(doc);}catch(error){reject(error);}},onerror:()=>reject(new Error('7digital request failed')),ontimeout:()=>reject(new Error('7digital request timed out'))});});}
    function sdDecorate(record){
        const formats=record.formats||[],baseTitle=record.baseTitle||record.title;
        return {...record,coverArt:comparisonArtworkSources(record.coverArt)[0]||record.coverArt,baseTitle,title:formats.length?baseTitle+' ('+formats.join(', ')+')':baseTitle};
    }
    async function sdRetain(record){
        const prior=(await readProviderCacheRecords(PROVIDERS.sevendigital,[record.key])).get(record.key);
        return sdDecorate({...record,formats:record.formats?.length?record.formats:prior?.formats||[],
            identityEvidence:[...new Map([...(prior?.identityEvidence||[]),...(record.identityEvidence||[])].map(e=>[JSON.stringify(e),e])).values()]});
    }
    function sdBarcodeEvidence(target,record){
        const evidence=(record.identityEvidence||[]).filter(e=>e.kind==='barcode-search'&&gtinsMatch(e.gtin,target.gtin));
        if(!evidence.length)return null;
        return evidence.every(e=>e.uniqueRelease)?'definitive':'navigation';
    }
    function sdAutoAccept(target,record){
        return sdCountry(record.url)===sdRegion(target)&&Number(target.trackCount)>0&&record.trackCount===Number(target.trackCount)&&
            fullReleaseIsComplete(record)&&(!record.gtin||gtinsMatch(target.gtin,record.gtin))&&sdBarcodeEvidence(target,record)==='definitive'&&!trackLengthAcceptanceReason(target,record);
    }
    async function sdBackgroundSearch({target,observe,signal,barcodeOnly=false}){
        let url=sdSearch(target);
        try{
            if(sdUrl(target.url))return {status:'candidate',record:{level:1,url:sdUrl(target.url),key:sdKey(target.url),country:sdCountry(target.url)}};
            if(/^\d{8}$|^\d{12,14}$/.test(clean(target.gtin))){
                const query=new URL(url);query.search='';query.searchParams.set('q',target.gtin);url=query.href;
                const doc=await sdDocument(url,false,signal);
                let records=sdCards(doc.querySelector('.search-results-album')||doc,url);
                const count=new Set(records.map(r=>r.key)).size;
                const complete=clean(doc.querySelector('.full-search input[name=q]')?.value)===clean(target.gtin)&&!doc.querySelector('a[rel="next"],.pagination a[href],a.load-more,[data-next-page]');
                records=records.map(record=>({...record,identityEvidence:[{kind:'barcode-search',gtin:target.gtin,uniqueRelease:complete&&count===1,resultCount:count,completeSearch:complete}]}));
                await observeProviderBatch(observe,1,records);
                if(records.length)return {status:'candidate',record:records[0]};
            }
            if(barcodeOnly||!providerLookupInput(PROVIDERS.sevendigital,target).searchable)return {status:'no-match'};
            url=sdSearch(target);
            const records=sdCards(await sdDocument(url,false,signal),url);await observeProviderBatch(observe,1,records);
            const record=records.find(r=>classifyProviderMatch(PROVIDERS.sevendigital,target,r));
            return record?{status:'candidate',record}:{status:'no-match'};
        }catch(error){debugWarn('7digital search unavailable',error);return {status:'interaction-required',url:error.interactionUrl||url,reason:error.reason||'search-unavailable'};}
    }
    async function sdBackgroundEnrich({record,signal}){
        try{
            let doc=await sdDocument(record.url,true,signal),release=sdRelease(doc,record.url);
            if(!release){doc=await sdDocument(record.url,false,signal);release=sdRelease(doc,record.url);}
            return release?{status:'candidate',record:await sdRetain({...release,formats:record.formats||[],identityEvidence:record.identityEvidence||[]})}:{status:'interaction-required',url:record.url};
        }catch(error){debugWarn('7digital release unavailable',error);return {status:'interaction-required',url:record.url,reason:error.reason||'enrichment-unavailable'};}
    }
    function sdObserve(emit){let timer,last='',signature='',listing='',busy=false,again=false;const scan=async()=>{if(busy){again=true;return;}busy=true;try{const route=location.href;if(route!==last){last=route;signature='';listing='';sdCurrent=null;}if(sdBlocked(document)){await emit({kind:'blocked',level:1,records:[],ready:false});return;}const records=sdCards(document,route),listSignature=JSON.stringify(records);if(records.length&&listing!==listSignature){listing=listSignature;await emit({kind:location.pathname==='/search'?'search':'listing',level:1,records,ready:true});}let release=sdRelease(document,route);if(release){release=await sdRetain(release);if(location.href!==route)return;const next=JSON.stringify(release);sdCurrent=release;if(signature!==next){signature=next;await emit({kind:'release',level:release.level,records:[release],ready:true});}}}catch(error){debugWarn('7digital observation failed',error);}finally{busy=false;if(again){again=false;schedule();}}};const schedule=()=>{clearTimeout(timer);timer=setTimeout(scan,250);};new MutationObserver(changes=>{if(changes.some(change=>!change.target.closest?.('#'+PROVIDER_PANEL_ID)))schedule();}).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('popstate',schedule);setInterval(()=>{if(location.href!==last)schedule();},500);schedule();}
    PROVIDERS.sevendigital={
        releaseActions:{types:{artist:[['purchase for download',176]]},
            identity:(value,type)=>{try{const url=new URL(value);return type==='artist'&&sdCountry(value)&&/^\/artist\/[^/]+\/?$/.test(url.pathname)?url.hostname+url.pathname.replace(/\/$/,''):'';}catch{return '';}}},id:'sevendigital',name:'7digital',harmony:{native:false,want:'full-release'},lookupInputs:{gtinCache:true,gtinBackground:true,barcodeBeforeTextCache:true},requireUserConfirmation:false,
        preserveIdentityFields:['identityEvidence','formats'],normalizeObservation:sdDecorate,hasBarcodeEvidence:(target,record)=>Boolean(sdBarcodeEvidence(target,record)),classifyEvidence:sdBarcodeEvidence,canAutoAccept:sdAutoAccept,
        preprocessComparison:value=>({...value,title:value.baseTitle||value.title}),
        getComparisonValues:record=>!record?.gtin&&record?.identityEvidence?.length?{gtin:[...new Set(record.identityEvidence.map(e=>e.gtin))].map(value=>({value,assumption:'Associated through barcode search; not supplied in release metadata'}))}:{},
        presentation:{backgroundColor:'rgb(4, 141, 163)',color:'#fff',controlForeground:'#fff',controlIconSize:24,iconSize:16,icon:{tag:'svg',attrs:{viewBox:'0 0 150 150'},children:[{tag:'path',attrs:{fill:'currentColor',d:'M38.91,13.37V56.05h38.89l-19.45,43.37,19.57,42.58L116.11,59.13c.85-1.85,.85-3.97-.01-5.81L98.45,15.43c-.58-1.25-1.84-2.05-3.22-2.05H38.91Z'}}]}},
        isBlockedPage:()=>sdBlocked(document),formatProviderLabel:release=>release.country+': '+release.id,isCurrentSite:()=>Boolean(sdCountry(location.href)),isSearchPage:()=>location.pathname==='/search',isReleasePage:()=>Boolean(sdUrl(location.href)),matchesReleaseUrl:value=>Boolean(sdUrl(value)),getReleaseKey:sdKey,buildSearchUrl:sdSearch,isCandidateEligible:(target,record)=>sdCountry(record.url)===sdRegion(target),backgroundSearch:sdBackgroundSearch,backgroundEnrich:sdBackgroundEnrich,observePage:sdObserve,getCurrentRelease:()=>sdCurrent?.key===sdKey(location.href)?sdCurrent:null,canManuallyAccept:fullReleaseIsComplete};

    // =========================================================================
    // RELEASE ACTIONS — shared MB snapshot, proposal planning and native UI
    // Provider-specific URL/relationship rules live in provider.releaseActions.
    // Nothing here submits edits: links open the existing MB/MagicISRC editors.
    // =========================================================================
    const MPLReleaseActions = (() => {
        const MB_ORIGIN='https://musicbrainz.org', PANEL_ID='hmpl-release-actions';
        const validMbid=value=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value||'');
        const name=value=>clean(value?.name||value).normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'");
        const isrc=value=>{const code=clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'');return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code)?code:'';};
        const isrcs=track=>[...new Set([track?.isrc,...(track?.isrcs||[])].flat().map(isrc).filter(Boolean))];
        const tracks=release=>(release?.media||[]).flatMap(medium=>medium.tracks||[]);
        const artists=release=>[...new Map([...(release?.['artist-credit']||[]),...tracks(release).flatMap(track=>track['artist-credit']||[])].filter(credit=>validMbid(credit.artist?.id)).map(credit=>[credit.artist.id,{...credit.artist,creditedName:credit.name}])).values()];
        const labels=release=>[...new Map((release?.['label-info']||[]).filter(info=>validMbid(info.label?.id)).map(info=>[info.label.id,info.label])).values()];
        function sameUrl(provider,type,left,right){
            const a=provider.releaseActions.identity(left,type),b=provider.releaseActions.identity(right,type);
            return Boolean(a&&b&&a===b);
        }
        function entityLinks(provider,type,entity){
            const rules=provider.releaseActions,url=rules.entityUrl?rules.entityUrl(entity,type):entity?.url;
            if(!url||!rules.identity(url,type))return [];
            return (rules.types[type]||[]).map(([relation,id])=>({url,relation,id}));
        }
        function matchEntity(provider,type,entity,entities){
            const links=entityLinks(provider,type,entity);
            if(!links.length)return null;
            const linked=entities.filter(mb=>(mb.relations||[]).some(rel=>!rel.ended&&rel.url&&links.some(link=>sameUrl(provider,type,link.url,rel.url.resource))));
            if(linked.length)return linked.length===1?linked[0]:null;
            const matches=entities.filter(mb=>[mb.name,mb.creditedName].some(value=>name(value)&&name(value)===name(entity)));
            return matches.length===1?matches[0]:null;
        }
        function mapTracks(release,record){
            const mb=tracks(release),source=record.tracks||[];
            if(!mb.length||mb.length!==source.length||Number(record.trackCount??source.length)!==mb.length)return null;
            // The applied MB release URL establishes release identity. Preserve
            // the release's ordered tracklist instead of nominating it again.
            return source.map((track,index)=>({source:track,target:mb[index],position:index}));
        }

        function plan(release,slots,artistData,labelData){
            const proposals=[],codes=[],warnings=[],checks=new Set();
            for(const slot of slots){
                if(slot.state!=='ready')continue;
                const {provider}=slot,record=normalizeFullRelease(slot.record);
                record.tracks=record.media.flatMap(medium=>medium.tracks);
                const add=(type,entity,mb)=>{if(!mb)return;for(const link of entityLinks(provider,type,entity))proposals.push({type,mbid:mb.id,name:mb.name||mb.title,provider,source:record.url,...link});};
                const credits=artists(release);
                const knownArtists=artistData?.map(entity=>({...credits.find(credit=>credit.id===entity.id),...entity}))||credits;
                for(const entity of [...(record.artists||[]),...(record.tracks||[]).flatMap(track=>track.artists||[])]){
                    if(credits.length&&entityLinks(provider,'artist',entity).length)checks.add('artist');
                    const mb=matchEntity(provider,'artist',entity,knownArtists);add('artist',entity,mb);
                    if(!mb&&entityLinks(provider,'artist',entity).length)warnings.push(provider.name+': artist '+(entity.name||entity)+' could not be uniquely matched.');
                }
                for(const entity of record.labels||[]){
                    if(labels(release).length&&entityLinks(provider,'label',entity).length)checks.add('label');
                    const mb=matchEntity(provider,'label',entity,labelData||labels(release));add('label',entity,mb);
                    if(!mb&&entityLinks(provider,'label',entity).length)warnings.push(provider.name+': label '+(entity.name||entity)+' could not be uniquely matched.');
                }
                const mapping=mapTracks(release,record);
                if(!mapping){warnings.push(provider.name+': track counts differ (MusicBrainz: '+tracks(release).length+', provider: '+record.tracks.length+', declared: '+(record.trackCount??record.tracks.length)+'); recording links and ISRCs withheld.');continue;}
                for(const {source,target,position} of mapping){
                    const recording=target.recording;if(!validMbid(recording?.id))continue;
                    add('recording',source,recording);
                    for(const code of isrcs(source))if(!(recording.isrcs||[]).map(isrc).includes(code))codes.push({position,code,provider,source:record.url});
                }
            }
            return {proposals,codes,warnings:[...new Set(warnings)],checks};
        }
        function missing(proposal,entities){
            const entity=entities.find(value=>value.id===proposal.mbid);
            if(!entity)return null; // Not returned is not evidence of absence.
            return !(entity.relations||[]).some(rel=>!rel.ended&&rel.type===proposal.relation&&rel.url&&sameUrl(proposal.provider,proposal.type,proposal.url,rel.url.resource));
        }
        function editIdentity(link){
            try{const url=new URL(link.href),match=url.pathname.match(/^\/(artist|label|recording)\/([a-f0-9-]{36})\/edit\/?$/i);return /^(?:beta\.|test\.)?musicbrainz\.(org|eu)$/.test(url.hostname)&&match?{type:match[1],mbid:match[2],url}:null;}catch{return null;}
        }
        function start(){
            const mbid=new URL(location.href).searchParams.get('release_mbid')?.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0];
            if(!validMbid(mbid)){setMplFlowStatus('finished');return;}
            const main=document.querySelector('main')||document.body;
            const panel=injectionElement('div','message info');panel.id=PANEL_ID;
            panel.append(createHarmonySpriteIcon('info-circle'),injectionElement('span','provider','More Provider Lookups:'));
            const body=injectionElement('div','hmpl-message-body');panel.append(body);
            const heading=[...main.querySelectorAll('h2')].find(node=>clean(node.textContent)==='Release Actions');
            if(heading)heading.after(panel);else main.prepend(panel);
            const style=injectionElement('style');style.textContent=`[data-hmpl-action-locked]{opacity:.45!important;cursor:wait!important} #${PANEL_ID} ul{margin:.3em 0;padding-left:1.4em} #${PANEL_ID} button{margin:.25em .4em .25em 0}`;document.head.append(style);
            const controller=acquisitionController(),signal=controller.signal;
            const tasks=new Map(),slots=new Map(),patches=new Map(),locked=new Map(),artwork=new Map();
            let busy=false,discovering=false,rerun=false,cacheTimer=null,lastRequest=0,disposed=false,currentPlan={proposals:[],codes:[],warnings:[]};
            let actionSummary={added:0,existing:0};
            let writer=Promise.resolve();
            const task=(key,label)=>{if(!tasks.has(key))tasks.set(key,{key,label,state:'pending',data:null,offset:0,rows:[]});return tasks.get(key);};
            const releaseTask=task('release','MusicBrainz release, recordings and ISRCs');
            function json(url){
                const run=async()=>{
                    checkAcquisition(signal);
                    const delay=Math.max(0,1100-(Date.now()-lastRequest));
                    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
                    checkAcquisition(signal);lastRequest=Date.now();
                    return new Promise((resolve,reject)=>providerHttp(signal,{method:'GET',url:String(url),anonymous:true,timeout:30000,headers:{Accept:'application/json'},onload:response=>{
                        if(response.status!==200)return reject(new Error('MusicBrainz HTTP '+response.status));
                        try{resolve(JSON.parse(response.responseText));}catch{reject(new Error('MusicBrainz returned invalid JSON'));}
                    },onerror:()=>reject(new Error('MusicBrainz network request failed')),ontimeout:()=>reject(new Error('MusicBrainz request timed out'))}));
                };
                const pending=writer.then(run);writer=pending.catch(()=>{});return pending;
            }
            const lockAttributes=['aria-disabled','tabindex','disabled'];
            function restoreLocks(){
                // DOM replacement (including another userscript cloning a button)
                // must carry its pre-lock state, not turn our lock into a default.
                for(const node of main.querySelectorAll('[data-hmpl-lock-state]'))if(!locked.has(node)){
                    try{const attrs=JSON.parse(node.dataset.hmplLockState);if(attrs&&lockAttributes.every(key=>attrs[key]===null||typeof attrs[key]==='string'))locked.set(node,attrs);}catch{}
                }
                for(const [node,attrs]of locked){node.removeAttribute('data-hmpl-action-locked');node.removeAttribute('data-hmpl-lock-state');for(const key of lockAttributes){const value=attrs[key];if(value===null)node.removeAttribute(key);else node.setAttribute(key,value);}}
                locked.clear();
            }
            function lock(node){if(locked.has(node))return;const attrs=Object.fromEntries(lockAttributes.map(key=>[key,node.getAttribute(key)]));locked.set(node,attrs);node.dataset.hmplLockState=JSON.stringify(attrs);node.dataset.hmplActionLocked='true';node.setAttribute('aria-disabled','true');node.setAttribute('tabindex','-1');if(node.matches('button,input'))node.setAttribute('disabled','');}
            const failures=()=>[...tasks.values()].some(value=>value.state==='error');
            function syncLocks(){
                restoreLocks();if(!busy)return;
                const pendingProviders=discovering||[...slots.values()].some(slot=>['pending','loading'].includes(slot.state));
                const ids=new Set(currentPlan.proposals.map(item=>item.type+':'+item.mbid));
                for(const link of main.querySelectorAll('.action a[href]')){
                    const entity=editIdentity(link);
                    const dependency=entity?.type==='recording'||link.matches('.magic-isrc')?releaseTask:tasks.get(entity?.type);
                    const waiting=dependency?['pending','loading'].includes(dependency.state):Boolean(entity&&ids.has(entity.type+':'+entity.mbid));
                    if((entity||link.matches('.magic-isrc'))&&(pendingProviders||waiting))lock(link);
                }
                for(const group of main.querySelectorAll('.action-group'))if(group.querySelector('a[data-hmpl-action-locked]'))group.querySelectorAll('button.open-all-links').forEach(lock);
                // Some Harmony layouts put the open-all control outside its group.
                for(const button of main.querySelectorAll('button.open-all-links'))if([...locked.keys()].some(node=>editIdentity(node)?.type===openAllType(button)))lock(button);
            }
            function guard(event){if(event.target.closest?.('[data-hmpl-action-locked]')){event.preventDefault();event.stopImmediatePropagation();}}
            document.addEventListener('click',guard,true);document.addEventListener('auxclick',guard,true);
            function render(){
                const complete=!busy&&releaseTask.state==='ready'&&[...tasks.values(),...slots.values()].every(value=>value.state==='ready');
                panel.style.borderColor=complete?'#4caf50':'';
                panel.style.backgroundColor=complete?'#e8f5e9':'';
                panel.style.color=complete?'#1b5e20':'';
                body.replaceChildren();const list=injectionElement('ul');
                for(const value of [...tasks.values(),...slots.values()]){
                    const row=injectionElement('li','',value.label+': '+({pending:'waiting',loading:'working…',ready:'complete',error:value.error||'failed',interaction:'website interaction required'}[value.state]||value.state));
                    if(value.state==='interaction'){
                        const link=injectionElement('a','','Open linked release');link.href=value.url;link.target='_blank';link.rel='noopener';row.append(' — ',link);
                    }list.append(row);
                }
                if(releaseTask.state==='ready'&&!slots.size)list.append(injectionElement('li','','No active release links for MPL providers.'));
                if(!busy&&releaseTask.state==='ready'){
                    list.append(injectionElement('li','',actionSummary.added+' release action(s) added.'),injectionElement('li','',actionSummary.existing+' relationship(s) already existed.'));
                    list.append(injectionElement('li','',new Set(currentPlan.warnings).size+' item(s) skipped.'));
                }
                body.append(list);
                if(failures()){
                    const retry=injectionElement('button','','Retry failed requests');retry.type='button';retry.disabled=busy;
                    retry.addEventListener('click',()=>{for(const value of tasks.values())if(value.state==='error'){value.state='pending';value.error='';}run();});body.append(retry);
                }
                if([...slots.values()].some(slot=>slot.state==='interaction')){
                    const retry=injectionElement('button','','Check provider cache again');retry.type='button';retry.disabled=busy;retry.addEventListener('click',()=>run());body.append(retry);
                    const fetch=injectionElement('button','','Retry unavailable provider lookups');fetch.type='button';fetch.disabled=busy;
                    fetch.addEventListener('click',()=>{for(const slot of slots.values())if(slot.state==='interaction')slot.state='pending';run();});body.append(fetch);
                }
                syncLocks();
            }
            async function perform(value,work){
                if(value.state!=='pending')return;
                value.state='loading';render();
                try{value.data=await work();checkAcquisition(signal);value.state='ready';value.error='';}
                catch(error){if(signal.aborted)throw error;value.state='error';value.error=error.message;debugWarn('Release Actions',value.label,error);}
                render();
            }
            async function browse(type){
                const value=task(type,'MusicBrainz '+type+' links');
                await perform(value,async()=>{
                    while(true){
                        const url=new URL(MB_ORIGIN+'/ws/2/'+type);url.search=new URLSearchParams({release:mbid,inc:'url-rels',limit:'100',offset:String(value.offset),fmt:'json'});
                        const data=await json(url),rows=data[type+'s'],count=data[type+'-count'];
                        if(!Array.isArray(rows)||!Number.isInteger(count)||count<0||rows.some(row=>!validMbid(row.id)||!Array.isArray(row.relations)))throw new Error('Incomplete MusicBrainz '+type+' response');
                        if(!rows.length&&value.offset<count)throw new Error('Incomplete MusicBrainz '+type+' page');
                        value.rows.push(...rows);value.offset+=rows.length;
                        if(value.offset>=count)return [...new Map(value.rows.map(row=>[row.id,row])).values()];
                    }
                });
            }
            function patchProviderList(){
                let list=main.querySelector('ul.provider-list');
                if(!list&&heading){list=injectionElement('ul','provider-list');list.dataset.hmplProviderList='true';heading.before(list);}
                if(!list)return;
                list.querySelectorAll('[data-hmpl-action-provider-row]').forEach(row=>row.remove());
                for(const slot of slots.values()){
                    const {provider,url}=slot;
                    if([...list.querySelectorAll('a[href]')].some(link=>provider.matchesReleaseUrl(link.href)&&provider.getReleaseKey(link.href)===provider.getReleaseKey(url)))continue;
                    const record=slot.record||{key:provider.getReleaseKey(url),url};
                    const row=injectionElement('li');row.dataset.hmplActionProviderRow=slot.key;row.dataset.mplProvider=provider.id;
                    row.append(injectionProviderIcon(provider),provider.name+': ');
                    const label=slot.record&&provider.formatProviderLabel?provider.formatProviderLabel(record):clean(record.key).replace(/^https?:\/\//,'');
                    const link=injectionElement('a','provider-id',label||url);link.href=url;
                    row.append(link,injectionElement('span','label ml-2','via More Provider Lookups'));list.append(row);
                }
                orderHarmonyProviderElements();
            }
            async function discover(){
                const urls=[...new Set(releaseTask.data.relations.filter(rel=>!rel.ended&&rel.url).map(rel=>rel.url.resource))],wanted=new Set();
                for(const provider of orderedProviders().filter(provider=>provider.harmony?.native===false&&provider.releaseActions))for(const url of urls.filter(url=>provider.matchesReleaseUrl(url))){
                    const key=provider.id+':'+provider.getReleaseKey(url);wanted.add(key);
                    if(!slots.has(key))slots.set(key,{key,provider,url,label:provider.name+' — '+provider.getReleaseKey(url),state:'pending',record:null});
                }
                for(const key of slots.keys())if(!wanted.has(key))slots.delete(key);
                const ordered=[...wanted].map(key=>[key,slots.get(key)]);slots.clear();for(const [key,slot]of ordered)slots.set(key,slot);
                patchProviderList();
                const snapshot=await readCacheSnapshot();
                for(const slot of slots.values()){
                    const {provider,url}=slot;
                    const records=snapshot.blocks.flatMap(block=>[...block.records].reverse()).filter(record=>record.provider===provider.id&&
                        (provider.getReleaseKey(record.url)===provider.getReleaseKey(url)||provider.releaseActions.matchesRecord?.(url,record)));
                    const record=records.find(record=>record.level===2&&fullReleaseIsComplete(record));
                    if(record){slot.record=record;slot.state='ready';continue;}
                    if(slot.state==='ready'||slot.state==='interaction')continue;
                    slot.state='loading';render();
                    try{
                        const seed=records[0]||{url,key:provider.getReleaseKey(url),level:1};
                        const hook=provider.releaseActions.acquire||provider.backgroundEnrich;
                        const outcome=hook?await hook({record:seed,target:{url},want:'full-release',signal,observe:providerObservationSink(provider,signal)}):null;
                        checkAcquisition(signal);
                        const result=outcome?.record;
                        if(!result||result.level!==2||!fullReleaseIsComplete(result)||!(provider.getReleaseKey(result.url)===provider.getReleaseKey(url)||provider.releaseActions.matchesRecord?.(url,result)))throw new Error('Release details require a website visit');
                        slot.record=normalizeProviderObservation(provider,2,result);slot.state='ready';await storeCacheObservations(provider,[{level:2,record:slot.record}]);
                    }catch(error){if(signal.aborted)throw error;slot.state='interaction';debugWarn('Release Actions provider acquisition',provider.id,error);}
                    recalculate();render();
                }
            }
            function recalculate(){
                if(!releaseTask.data)return;
                patchProviderList();
                currentPlan=plan(releaseTask.data,[...slots.values()],tasks.get('artist')?.data,tasks.get('label')?.data);
            }
            function rollback(){
                for(const [link,patch]of patches){
                    patch.icons?.forEach(icon=>icon.remove());
                    if(!link.isConnected)continue;
                    const url=new URL(link.href);
                    for(const [key,value]of patch.added)if(url.searchParams.get(key)===value)url.searchParams.delete(key);
                    for(const [key,value]of patch.replaced)if(url.searchParams.get(key)===value.after){if(value.before===null)url.searchParams.delete(key);else url.searchParams.set(key,value.before);}
                    const note=url.searchParams.get(patch.noteKey)||'';
                    const cleaned=note.split('\n').filter(line=>!patch.notes.includes(line)).join('\n');
                    if(cleaned)url.searchParams.set(patch.noteKey,cleaned);else url.searchParams.delete(patch.noteKey);
                    link.href=url.href;
                    if(patch.created&&![...url.searchParams].some(([key,value])=>value&&/\.url\.\d+\.text$|^isrc\d+$/.test(key)))link.closest('[data-hmpl-created-action]')?.remove();
                }patches.clear();
            }
            function placeEntityGroup(group,type){
                if(!['artist','label'].includes(type)){main.append(group);return;}
                // Use action URLs rather than translated button text. The whole
                // native action/group stays together, including open-all controls.
                const block=link=>{
                    if(!link)return null;
                    let node=link?.closest('.action-group')||link?.closest('.action');
                    while(node?.parentElement&&node.parentElement!==main)node=node.parentElement;
                    return node?.parentElement===main?node:null;
                };
                const links=[...main.querySelectorAll('.action a[href]')];
                const releaseAction=suffix=>links.find(link=>{try{const url=new URL(link.href);return /^(?:beta\.|test\.)?musicbrainz\.(org|eu)$/.test(url.hostname)&&url.pathname.replace(/\/$/,'')==='/release/'+mbid+suffix;}catch{return false;}});
                const before=block(type==='artist'&&links.find(link=>editIdentity(link)?.type==='label'))||block(releaseAction('/add-cover-art'));
                if(before){before.before(group);return;}
                const after=(type==='label'?block(links.filter(link=>editIdentity(link)?.type==='artist').at(-1)):null)||block(releaseAction(''));
                if(after)after.after(group);else main.append(group);
            }
            function action(type,mbid,label){
                const existing=[...main.querySelectorAll('.action a[href]')].find(link=>{const identity=editIdentity(link);return identity?.type===type&&identity.mbid===mbid;});
                if(existing)return {link:existing,created:Boolean(existing.closest('[data-hmpl-created-action]'))};
                let group=main.querySelector('[data-hmpl-action-group="'+type+'"]');
                if(!group){group=injectionElement('div','action-group');group.dataset.hmplActionGroup=type;placeEntityGroup(group,type);}
                const row=injectionElement('div','action');row.dataset.hmplCreatedAction='true';
                const content=injectionElement('div'),p=injectionElement('p'),link=injectionElement('a','','Link external IDs');link.href=MB_ORIGIN+'/'+type+'/'+mbid+'/edit';
                const entity=injectionElement('a','',label||mbid);entity.href=MB_ORIGIN+'/'+type+'/'+mbid;
                p.append(link,' of ',entity,' to MusicBrainz');content.append(p);row.append(createHarmonySpriteIcon('link'),content);group.append(row);return {link,created:true};
            }
            function patchNote(url,patch,sources){
                patch.notes=[...new Set(sources.map(item=>injectionEditNote(item.provider,{url:item.source})))];
                const existing=url.searchParams.get(patch.noteKey)||'';
                patch.notes=patch.notes.filter(line=>!existing.split('\n').includes(line));
                url.searchParams.set(patch.noteKey,[existing,...patch.notes].filter(Boolean).join('\n'));
            }
            function patchEntityIcons(link,proposals){
                const {type,mbid}=proposals[0],row=link.closest('.action');
                const entity=[...row.querySelectorAll('a[href]')].find(node=>{try{return new URL(node.href).pathname.replace(/\/$/,'')==='/'+type+'/'+mbid;}catch{return false;}});
                if(!entity)return [];
                let container=entity.closest('.entity-links');
                if(!container){container=injectionElement('span','entity-links');entity.before(container);container.append(entity);}
                const icons=[];
                for(const proposal of proposals){
                    if([...container.querySelectorAll('a[href]')].some(node=>sameUrl(proposal.provider,type,node.href,proposal.url)))continue;
                    const icon=injectionElement('a');icon.href=proposal.url;icon.dataset.hmplActionProvider=proposal.provider.id;
                    icon.append(injectionProviderIcon(proposal.provider));entity.before(icon);icons.push(icon);
                }
                return icons;
            }
            function patchActions(){
                rollback();actionSummary={added:0,existing:0};if(releaseTask.state!=='ready')return;
                const groups=new Map(),seen=new Set();
                for(const proposal of currentPlan.proposals){
                    const data=proposal.type==='recording'?tracks(releaseTask.data).map(track=>track.recording):tasks.get(proposal.type)?.state==='ready'?tasks.get(proposal.type).data:null;
                    if(!data)continue;
                    const identity=JSON.stringify([proposal.type,proposal.mbid,proposal.provider.id,proposal.relation,proposal.provider.releaseActions.identity(proposal.url,proposal.type)]);
                    if(seen.has(identity))continue;seen.add(identity);
                    const absent=missing(proposal,data);
                    if(absent===null){currentPlan.warnings.push('MusicBrainz did not return '+proposal.type+' '+proposal.name+'; additions withheld.');continue;}
                    if(!absent){actionSummary.existing++;continue;}
                    const key=proposal.type+':'+proposal.mbid;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(proposal);
                }
                for(const proposals of groups.values()){
                    const first=proposals[0],{link,created}=action(first.type,first.mbid,first.name),url=new URL(link.href),prefix='edit-'+first.type;
                    const patch={added:new Map(),replaced:new Map(),notes:[],noteKey:prefix+'.edit_note',created};
                    for(const proposal of proposals){
                        const entries=[...url.searchParams].filter(([key])=>new RegExp('^'+prefix+'\\.url\\.\\d+\\.text$').test(key));
                        if(entries.some(([key,value])=>sameUrl(proposal.provider,proposal.type,value,proposal.url)&&url.searchParams.get(key.replace(/\.text$/,'.link_type_id'))===String(proposal.id)))continue;
                        const index=Math.max(-1,...entries.map(([key])=>Number(key.match(/\.url\.(\d+)/)[1])))+1;
                        for(const [key,value]of [[prefix+'.url.'+index+'.text',proposal.url],[prefix+'.url.'+index+'.link_type_id',String(proposal.id)]]){url.searchParams.set(key,value);patch.added.set(key,value);}
                    }
                    patch.icons=patchEntityIcons(link,proposals);
                    if(patch.added.size){patchNote(url,patch,proposals);link.href=url.href;}
                    if(patch.added.size||patch.icons.length)patches.set(link,patch);
                }
                patchIsrcs();patchArtwork();syncOpenAll();
                actionSummary.added=[...patches.values()].filter(patch=>patch.added.size||patch.replaced.size).length;
            }
            function patchArtwork(){
                const native=[...main.querySelectorAll('figure.cover-image:not([data-hmpl-cover])')];
                const visible=new Set(native.flatMap(figure=>comparisonArtworkSources(figure.querySelector('a[href]')?.href||figure.querySelector('img')?.src).map(injectionUrl).filter(Boolean)));
                const wanted=new Map();
                for(const {state,provider,record}of slots.values()){
                    if(state!=='ready')continue;
                    // Harmony owns artwork for native providers, including Bandcamp.
                    if(provider.harmony?.native!==false)continue;
                    const source=injectionUrl(record.coverArt);if(!source)continue;
                    const sources=comparisonArtworkSources(source).map(injectionUrl).filter(Boolean),key=sources[0];
                    if(sources.some(url=>visible.has(url)))continue;
                    sources.forEach(url=>visible.add(url));wanted.set(key,{provider,sources});
                }
                for(const [key,figure]of artwork)if(!wanted.has(key)){figure.remove();artwork.delete(key);}
                let anchor=main.querySelector('a[href*="/release/'+mbid+'/add-cover-art"]')?.closest('.action');
                if(wanted.size&&!anchor){
                    anchor=injectionElement('div','action');anchor.dataset.hmplCoverAction='true';
                    const content=injectionElement('div'),p=injectionElement('p'),link=injectionElement('a','','Add cover art');
                    link.href=MB_ORIGIN+'/release/'+mbid+'/add-cover-art';p.append(link);content.append(p);anchor.append(createHarmonySpriteIcon('photo-plus'),content);
                    const recording=entityEditLinks('recording')[0];
                    const before=recording?.closest('.action-group')||recording?.closest('.action');
                    if(before)before.before(anchor);else main.append(anchor);
                }
                let previous=native.at(-1)||anchor;
                for(const [key,{provider,sources}]of wanted){
                    let figure=artwork.get(key);
                    if(!figure){
                        figure=injectionElement('figure','cover-image');figure.dataset.hmplCover='true';figure.dataset.provider=provider.name;
                        const link=injectionElement('a'),image=injectionElement('img'),caption=injectionElement('figcaption');
                        let index=0;link.href=sources[0];image.src=sources[0];image.alt=provider.name+' front cover';image.title='front';image.loading='lazy';image.decoding='async';
                        image.addEventListener('error',()=>{if(figure.isConnected&&++index<sources.length){link.href=sources[index];image.src=sources[index];}});
                        link.append(image);const source=injectionElement('span','label');source.dataset.hmplCoverSource='true';source.append('Source: ',injectionProviderIcon(provider),' '+provider.name);
                        caption.append(injectionElement('span','label','Type: front'),source);figure.append(link,caption);artwork.set(key,figure);
                    }
                    if(figure.dataset.provider!==provider.name){
                        figure.dataset.provider=provider.name;figure.querySelector('img').alt=provider.name+' front cover';
                        figure.querySelector('[data-hmpl-cover-source]').replaceChildren('Source: ',injectionProviderIcon(provider),' '+provider.name);
                    }
                    if(previous&&previous.nextElementSibling!==figure)previous.after(figure);
                    previous=figure;
                }
                if(!wanted.size)main.querySelector('[data-hmpl-cover-action]')?.remove();
                orderHarmonyProviderElements();
            }
            function patchIsrcs(){
                const positions=new Map();for(const item of currentPlan.codes){if(!positions.has(item.position))positions.set(item.position,[]);positions.get(item.position).push(item);}
                if(!positions.size)return;
                let link=main.querySelector('a.magic-isrc'),created=false;
                if(link){const target=new URL(link.href).searchParams.get('musicbrainzid');if(target&&target!==mbid){currentPlan.warnings.push('Existing ISRC action targets another release; left unchanged.');return;}}
                const additions=[];
                for(const [position,items]of positions){
                    if(new Set(items.map(item=>item.code)).size!==1){currentPlan.warnings.push('Conflicting provider ISRCs for track '+(position+1)+'; no ISRC added at this position.');continue;}
                    const key='isrc'+(position+1),existing=link&&new URL(link.href).searchParams.get(key);
                    if(existing&&isrc(existing)!==items[0].code){currentPlan.warnings.push('Existing ISRC suggestion differs at track '+(position+1)+'; left unchanged.');continue;}
                    if(!existing)additions.push({key,items});
                }
                if(!additions.length)return;
                if(!link){
                    created=true;const row=injectionElement('div','action');row.dataset.hmplCreatedAction='true';const p=injectionElement('p');
                    link=injectionElement('a','magic-isrc','Open with MagicISRC');link.href='https://magicisrc.kepstin.ca/';p.append(link,': Submit additional ISRCs to MusicBrainz');row.append(createHarmonySpriteIcon('disc'),p);
                    const releaseLink=[...main.querySelectorAll('.action a[href]')].find(node=>{try{const url=new URL(node.href);return /^(?:beta\.|test\.)?musicbrainz\.(org|eu)$/.test(url.hostname)&&url.pathname.replace(/\/$/,'')==='/release/'+mbid;}catch{return false;}});
                    const releaseRow=releaseLink?.closest('.action');
                    if(releaseRow)releaseRow.after(row);else main.append(row);
                }
                const url=new URL(link.href),patch={added:new Map(),replaced:new Map(),notes:[],noteKey:'edit-note',created};
                const set=(key,value)=>{const before=url.searchParams.get(key);if(before===value)return;patch.replaced.set(key,{before,after:value});url.searchParams.set(key,value);};
                set('musicbrainzid',mbid);tracks(releaseTask.data).forEach((_,index)=>{if(!url.searchParams.has('isrc'+(index+1)))set('isrc'+(index+1),'');});
                for(const {key,items}of additions){const original=patch.replaced.has(key)?patch.replaced.get(key).before:url.searchParams.get(key);patch.replaced.set(key,{before:original,after:items[0].code});url.searchParams.set(key,items[0].code);}
                patchNote(url,patch,additions.flatMap(value=>value.items));link.href=url.href;patches.set(link,patch);
            }
            function entityEditLinks(type){return [...main.querySelectorAll('.action a[href]')].filter(link=>editIdentity(link)?.type===type);}
            function openAllType(button){return button?.textContent.match(/\b(artist|label|recording)\b/i)?.[1]?.toLowerCase();}
            function syncOpenAll(){
                const links=entityEditLinks('recording');
                if(!links.length){main.querySelector('[data-hmpl-recording-all]')?.closest('.action')?.remove();return;}
                let button=[...main.querySelectorAll('button.open-all-links')].find(node=>openAllType(node)==='recording');
                if(!button){
                    const row=injectionElement('div','action'),p=injectionElement('p');button=injectionElement('button','open-all-links','Open all recording links');button.type='button';button.dataset.hmplRecordingAll='true';p.append(button);row.append(p);links[0].closest('.action').before(row);
                }
            }
            // Harmony's hydrated open-all button captures an old URL list. Read the
            // patched DOM at click time, including actions added by other scripts.
            async function openRecordings(event){
                const button=event.target.closest?.('button.open-all-links'),type=openAllType(button);if(!type)return;
                event.preventDefault();event.stopImmediatePropagation();
                const links=entityEditLinks(type);if(button.disabled||links.some(link=>locked.has(link)))return;
                const hrefs=[...new Set(links.map(link=>link.href))];
                if(hrefs.length>=10&&!globalThis.confirm('This will open '+hrefs.length+' new tabs. Continue?'))return;
                for(const href of hrefs){if(disposed||button.disabled)return;GM_openInTab(href,{active:false,insert:true});await new Promise(resolve=>setTimeout(resolve,300));}
            }
            document.addEventListener('click',openRecordings,true);
            async function run(){
                if(disposed)return;if(busy){rerun=true;return;}tasks.delete('processing');busy=true;discovering=true;setMplFlowStatus('busy');render();
                try{
                    await perform(releaseTask,async()=>{
                        const url=new URL(MB_ORIGIN+'/ws/2/release/'+mbid);url.search=new URLSearchParams({fmt:'json',inc:'artist-credits+labels+recordings+isrcs+url-rels+recording-level-rels'});
                        const release=await json(url);
                        if(release.id!==mbid||!Array.isArray(release.relations)||!Array.isArray(release.media)||release.media.some(medium=>!Array.isArray(medium.tracks)||medium.tracks.length!==medium['track-count'])||tracks(release).some(track=>!validMbid(track.recording?.id)||!Array.isArray(track.recording?.relations)||!Array.isArray(track.recording?.isrcs)))throw new Error('Incomplete MusicBrainz release response');
                        return release;
                    });
                    if(releaseTask.state!=='ready')return;
                    await discover();discovering=false;recalculate();
                    for(const type of ['artist','label'])if(!currentPlan.checks.has(type))tasks.delete(type);
                    patchActions();render();
                    for(const type of ['artist','label']){
                        if(currentPlan.checks.has(type)){await browse(type);recalculate();patchActions();render();}
                    }
                }catch(error){if(!signal.aborted){const failed=task('processing','Release Actions');failed.state='error';failed.error=error.message;debugWarn('Release Actions failed',error);}}
                finally{busy=false;discovering=false;restoreLocks();if(!disposed){setMplFlowStatus('finished');render();}if(rerun&&!disposed){rerun=false;run();}}
            }
            const cacheListener=GM_addValueChangeListener(CACHE_META_KEY,(_key,_old,_value,remote)=>{if(!remote)return;clearTimeout(cacheTimer);cacheTimer=setTimeout(()=>run(),300);});
            const observer=new MutationObserver(changes=>{if(changes.some(change=>!panel.contains(change.target))){orderHarmonyProviderElements();syncOpenAll();syncLocks();}});
            observer.observe(main,{childList:true,subtree:true});
            window.addEventListener('pagehide',event=>{if(event.persisted)return;disposed=true;controller.abort();acquisitionControllers.delete(controller);clearTimeout(cacheTimer);GM_removeValueChangeListener(cacheListener);observer.disconnect();restoreLocks();document.removeEventListener('click',guard,true);document.removeEventListener('auxclick',guard,true);document.removeEventListener('click',openRecordings,true);});
            run();
        }
        return {start,plan,mapTracks,missing,matchEntity,entityLinks};
    })();

    function getCurrentExternalProvider() {
        return Object.values(
            PROVIDERS
        )
            .find(
                provider =>
                    isProviderEnabled(provider) && provider.isCurrentSite?.()
            );
    }

    /*
     * Announce MPL immediately on Harmony.
     *
     * Other cooperating userscripts should not begin their own provider
     * work until MPL changes this to "finished".
     *
     * Preserve an explicit native-navigation continuation until initialization.
     * A leftover busy state alone may simply be an interrupted manual refresh.
     */
    if (
        isHarmony() &&
        !isHarmonySettings() &&
        (location.pathname==='/release/actions'||!harmonyContinuation())
    ) {
        setMplFlowStatus(
            'waiting'
        );
    }

    installCacheConsoleCommands();
    debugTrace('Entry: selecting page adapter', null, { page: location.href });
    const currentExternalProvider =
        getCurrentExternalProvider();
    if (currentExternalProvider || isHarmony()) void loadDistributorMap().catch(error=>debugWarn('Distributor dataset cache unavailable',error));

    if (
        currentExternalProvider
    ) {
        initializeExternalProvider(currentExternalProvider)
            .catch(
                error =>
                    debugWarn(
                        '[Harmony: More Provider Lookups]',
                        `${currentExternalProvider.name} initialization failed.`,
                        error
                    )
            );

    } else if (
        isHarmony()
    ) {
        function initializeHarmonyPage() {
            if (
                isHarmonySettings()
            ) {
                initializeHarmonySettings();
            } else if(location.pathname==='/release/actions') {
                MPLReleaseActions.start();
            } else {
                initializeHarmony();
            }
        }

        if (
            document.readyState ===
            'loading'
        ) {
            document.addEventListener(
                'DOMContentLoaded',
                initializeHarmonyPage,
                {
                    once: true
                }
            );
        } else {
            initializeHarmonyPage();
        }
    }
})();
