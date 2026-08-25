// ==UserScript==
// @name         Harmony: Beatport Recovery
// @namespace    https://github.com/djkhjg/musicbrainz-userscripts
// @version      0.4.1
// @description  Recovers Beatport metadata for Harmony using Beatport's browser search results and adds it to MusicBrainz seeds.
// @author       djkhjg
// @license      MIT
// @homepageURL  https://github.com/djkhjg/musicbrainz-userscripts/tree/main/harmony-beatport-recovery
// @supportURL   https://github.com/djkhjg/musicbrainz-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/djkhjg/musicbrainz-userscripts/main/harmony-beatport-recovery/harmony-beatport-recovery.user.js
// @updateURL    https://raw.githubusercontent.com/djkhjg/musicbrainz-userscripts/main/harmony-beatport-recovery/harmony-beatport-recovery.user.js
// @match        https://harmony.pulsewidth.org.uk/release*
// @match        https://harmony.mybrainz.dev/release*
// @match        https://www.beatport.com/search*
// @match        https://www.beatport.com/*/search*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function () {
    'use strict';

    const REQUEST_KEY = 'hbr-beatport-request';
    const RESULT_KEY = 'hbr-beatport-result';

    const BUTTON_ID = 'hbr-beatport-search-button';
    const LABEL_ALT_ID = 'hbr-beatport-label-alt';
    const PROVIDER_ITEM_ID = 'hbr-beatport-provider-item';
    const DEBUG_PANEL_ID = 'hbr-beatport-debug-panel';

    /*
     * MusicBrainz release URL relationship types:
     *
     * 74  = purchase for download
     * 980 = streaming page
     */
    const MB_PAID_DOWNLOAD_LINK_TYPE = '74';
    const MB_STREAMING_LINK_TYPE = '980';

    let activeBeatportResult = null;

    // =========================================================================
    // GENERAL HELPERS
    // =========================================================================

    function cleanText(value) {
        return (value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeBarcode(value) {
        return String(value || '')
            .replace(/\D/g, '')
            .replace(/^0+/, '');
    }

    function normalizeName(value) {
        return String(value || '')
            .normalize('NFKD')
            .toLowerCase()
            .replace(/[’‘]/g, "'")
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function makeRequestId() {
        if (crypto?.randomUUID) {
            return crypto.randomUUID();
        }

        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function slugify(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[^\w\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');
    }

    function createHiddenInput(form, name, value) {
        const input = document.createElement('input');

        input.type = 'hidden';
        input.name = name;
        input.value = value;

        form.appendChild(input);

        return input;
    }

    // =========================================================================
    // SITE DETECTION
    // =========================================================================

    function isHarmony() {
        return (
            location.hostname === 'harmony.pulsewidth.org.uk' ||
            location.hostname === 'harmony.mybrainz.dev'
        );
    }

    function isBeatport() {
        return location.hostname === 'www.beatport.com';
    }

    // =========================================================================
    // HARMONY — CURRENT RELEASE DATA
    // =========================================================================

    function getReleaseTitle() {
        const element = document.querySelector('.release-title');

        return element
            ? cleanText(element.textContent)
            : '';
    }

    function getReleaseArtist() {
        const container = document.querySelector('.release-artist');

        if (!container) {
            return '';
        }

        const artistCredit =
            container.querySelector('.artist-credit') ||
            container;

        return cleanText(artistCredit.textContent);
    }

    function getHarmonyBarcode() {
        /*
         * ONLY trust the GTIN displayed in the currently rendered Harmony
         * result.
         *
         * Never trust #gtin-input here. Browser history can leave that input
         * containing a barcode from an entirely different lookup.
         */
        const rows = document.querySelectorAll('.release-info tr');

        for (const row of rows) {
            const heading = row.querySelector('th');
            const value = row.querySelector('td');

            if (!heading || !value) {
                continue;
            }

            if (
                cleanText(heading.textContent).toUpperCase() !== 'GTIN'
            ) {
                continue;
            }

            const match = cleanText(value.textContent)
                .match(/\d{8,14}/);

            if (match) {
                return match[0];
            }
        }

        return '';
    }

    function buildBeatportSearchUrl() {
        const title = getReleaseTitle();
        const artist = getReleaseArtist();

        if (!title && !artist) {
            return null;
        }

        const query = [title, artist]
            .filter(Boolean)
            .join(' ');

        return (
            'https://www.beatport.com/search?q=' +
            encodeURIComponent(query)
        );
    }

    // =========================================================================
    // HARMONY — BEATPORT MESSAGE
    // =========================================================================

    function findBeatportMessage() {
        const messages = document.querySelectorAll('.message');

        for (const message of messages) {
            const provider = message.querySelector('.provider');

            if (!provider) {
                continue;
            }

            const providerName = cleanText(provider.textContent)
                .replace(/:$/, '')
                .trim();

            if (providerName.toLowerCase() === 'beatport') {
                return message;
            }
        }

        return null;
    }

    function getBeatportMessageContent(message) {
        return (
            message.querySelector('.provider')?.nextElementSibling ||
            message.lastElementChild ||
            message
        );
    }

    // =========================================================================
    // HARMONY — BUTTON
    // =========================================================================

    function createHarmonyButton() {
        const button = document.createElement('button');

        button.id = BUTTON_ID;
        button.type = 'button';
        button.textContent = 'Find on Beatport';

        Object.assign(button.style, {
            marginTop: '8px',
            padding: '6px 12px',
            border: '1px solid #777',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.9em',
            fontWeight: 'bold'
        });

        button.addEventListener('click', async () => {
            const searchUrl = buildBeatportSearchUrl();

            const barcode = getHarmonyBarcode();
            const title = getReleaseTitle();
            const artist = getReleaseArtist();

            if (!searchUrl) {
                alert(
                    'Could not determine the Harmony release title or artist.'
                );
                return;
            }

            if (!barcode) {
                alert(
                    'This Harmony result does not contain a UPC/GTIN.\n\n' +
                    'Beatport Recovery cannot automatically identify the ' +
                    'correct Beatport release without one.'
                );
                return;
            }

            const requestId = makeRequestId();

            const request = {
                requestId,
                timestamp: Date.now(),
                barcode,
                title,
                artist,
                searchUrl
            };

            await GM_setValue(REQUEST_KEY, request);
            await GM_deleteValue(RESULT_KEY);

            console.log(
                '[Harmony Beatport Recovery] Created request:',
                request
            );

            button.textContent = 'Waiting for Beatport…';
            button.disabled = true;

            const url = new URL(searchUrl);

            url.searchParams.set(
                'hbr',
                requestId
            );

            window.open(
                url.toString(),
                '_blank'
            );
        });

        return button;
    }

    function addHarmonyButton() {
        if (document.getElementById(BUTTON_ID)) {
            return;
        }

        const message = findBeatportMessage();

        if (!message) {
            return;
        }

        if (message.dataset.hbrRecovered === 'true') {
            return;
        }

        const content = getBeatportMessageContent(message);

        content.appendChild(
            createHarmonyButton()
        );
    }

    // =========================================================================
    // HARMONY — PROVIDER DISPLAY
    // =========================================================================

    function injectBeatportProvider(release) {
        const providerList =
            document.querySelector('.provider-list');

        if (!providerList) {
            return;
        }

        let item =
            document.getElementById(PROVIDER_ITEM_ID);

        if (!item) {
            item = document.createElement('li');
            item.id = PROVIDER_ITEM_ID;
            item.dataset.provider = 'Beatport';

            providerList.appendChild(item);
        }

        item.replaceChildren();

        const icon = document.createElement('span');
        icon.className = 'beatport';
        icon.title = 'Beatport';

        icon.innerHTML = `
            <svg class="icon" width="20" height="20" stroke-width="1.5">
                <use xlink:href="/icon-sprite.svg#brand-beatport"></use>
            </svg>
        `;

        const label = document.createTextNode('Beatport: ');

        const link = document.createElement('a');
        link.className = 'provider-id';
        link.href = release.releaseUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = release.releaseId;

        const recovered = document.createElement('span');
        recovered.className = 'label ml-2';
        recovered.textContent = 'Recovered by userscript';

        item.append(
            icon,
            label,
            link,
            recovered
        );
    }

    // =========================================================================
    // HARMONY — LABEL / CATALOG NUMBER DISPLAY
    // =========================================================================

    function injectBeatportLabelAlternative(release) {
        if (!release.label?.name) {
            return;
        }

        const rows = document.querySelectorAll('.release-info tr');

        let labelsCell = null;

        for (const row of rows) {
            const heading = row.querySelector('th');

            if (
                heading &&
                cleanText(heading.textContent).toLowerCase() === 'labels'
            ) {
                labelsCell = row.querySelector('td');
                break;
            }
        }

        if (!labelsCell) {
            return;
        }

        let altValues =
            labelsCell.querySelector(':scope > ul.alt-values');

        if (!altValues) {
            altValues = document.createElement('ul');
            altValues.className = 'alt-values';

            labelsCell.appendChild(altValues);
        }

        let beatportEntry =
            document.getElementById(LABEL_ALT_ID);

        if (!beatportEntry) {
            beatportEntry = document.createElement('li');
            beatportEntry.id = LABEL_ALT_ID;

            altValues.appendChild(beatportEntry);
        }

        beatportEntry.replaceChildren();

        const releaseLabels = document.createElement('ul');
        releaseLabels.className = 'release-labels inline';

        const releaseLabel = document.createElement('li');

        const entityLinks = document.createElement('span');
        entityLinks.className = 'entity-links';

        if (release.label.id) {
            const labelLink = document.createElement('a');

            labelLink.href =
                `https://www.beatport.com/label/` +
                `${slugify(release.label.name)}/${release.label.id}`;

            labelLink.target = '_blank';
            labelLink.rel = 'noopener noreferrer';

            const smallIcon = document.createElement('span');
            smallIcon.className = 'beatport';
            smallIcon.title = 'Beatport';

            smallIcon.innerHTML = `
                <svg class="icon" width="18" height="18" stroke-width="1.5">
                    <use xlink:href="/icon-sprite.svg#brand-beatport"></use>
                </svg>
            `;

            labelLink.appendChild(smallIcon);

            labelLink.appendChild(
                document.createTextNode(
                    release.label.name
                )
            );

            entityLinks.appendChild(labelLink);
        } else {
            entityLinks.textContent =
                release.label.name;
        }

        releaseLabel.appendChild(entityLinks);

        if (release.catalogNumber) {
            releaseLabel.appendChild(
                document.createTextNode(
                    ` ${release.catalogNumber}`
                )
            );
        }

        releaseLabels.appendChild(
            releaseLabel
        );

        const providerIcon = document.createElement('span');
        providerIcon.className = 'beatport';
        providerIcon.title = 'Beatport';

        providerIcon.innerHTML = `
            <svg class="icon" width="24" height="24" stroke-width="1.25">
                <use xlink:href="/icon-sprite.svg#brand-beatport"></use>
            </svg>
        `;

        beatportEntry.append(
            releaseLabels,
            providerIcon
        );
    }

    // =========================================================================
    // HARMONY — MUSICBRAINZ SEED
    // =========================================================================

    function getSeedLabels(form) {
        const labels = [];

        for (const input of form.querySelectorAll('input[name]')) {
            const match = input.name.match(
                /^labels\.(\d+)\.name$/
            );

            if (!match) {
                continue;
            }

            labels.push({
                index: Number(match[1]),
                name: input.value
            });
        }

        return labels;
    }

    function findSeedLabelIndex(form, beatportLabelName) {
        const labels = getSeedLabels(form);

        if (!labels.length) {
            return null;
        }

        const normalizedBeatport =
            normalizeName(beatportLabelName);

        const exactMatch = labels.find(
            label =>
                normalizeName(label.name) ===
                normalizedBeatport
        );

        if (exactMatch) {
            return exactMatch.index;
        }

        /*
         * If Harmony only has one label, associate the catalog number with
         * that label.
         */
        if (labels.length === 1) {
            return labels[0].index;
        }

        return null;
    }

    function injectCatalogNumberIntoReleaseSeed(form, release) {
        if (
            !release.catalogNumber ||
            !release.label?.name
        ) {
            return;
        }

        const labelIndex =
            findSeedLabelIndex(
                form,
                release.label.name
            );

        if (labelIndex === null) {
            console.warn(
                '[Harmony Beatport Recovery] ' +
                'Could not safely determine which seeded label should ' +
                'receive Beatport catalog number:',
                release.catalogNumber
            );

            return;
        }

        const fieldName =
            `labels.${labelIndex}.catalog_number`;

        let input =
            form.querySelector(
                `input[name="${fieldName}"]`
            );

        /*
         * Never silently overwrite a different catalog number that Harmony
         * already has.
         */
        if (input?.value) {
            if (
                cleanText(input.value) !==
                cleanText(release.catalogNumber)
            ) {
                console.warn(
                    '[Harmony Beatport Recovery] ' +
                    'Harmony already has a different catalog number; ' +
                    'leaving it unchanged.',
                    {
                        harmony: input.value,
                        beatport: release.catalogNumber
                    }
                );
            }

            return;
        }

        if (!input) {
            input = createHiddenInput(
                form,
                fieldName,
                release.catalogNumber
            );
        } else {
            input.value =
                release.catalogNumber;
        }

        input.dataset.hbrBeatport = 'true';

        console.log(
            '[Harmony Beatport Recovery] Seeded catalog number:',
            release.catalogNumber
        );
    }

    function getSeedUrlEntries(form) {
        const entries = new Map();

        for (const input of form.querySelectorAll('input[name]')) {
            let match =
                input.name.match(
                    /^urls\.(\d+)\.url$/
                );

            if (match) {
                const index = Number(match[1]);

                if (!entries.has(index)) {
                    entries.set(index, {});
                }

                entries.get(index).url =
                    input.value;

                continue;
            }

            match =
                input.name.match(
                    /^urls\.(\d+)\.link_type$/
                );

            if (match) {
                const index = Number(match[1]);

                if (!entries.has(index)) {
                    entries.set(index, {});
                }

                entries.get(index).linkType =
                    input.value;
            }
        }

        return entries;
    }

    function injectBeatportUrlIntoSeed(form, release) {
        if (!release.releaseUrl) {
            return;
        }

        /*
         * Beatport release pages are seeded as both:
         *
         *   74  = purchase for download
         *   980 = streaming page
         */
        const wantedLinkTypes = [
            MB_PAID_DOWNLOAD_LINK_TYPE,
            MB_STREAMING_LINK_TYPE
        ];

        for (const wantedType of wantedLinkTypes) {
            const entries =
                getSeedUrlEntries(form);

            let alreadyExists = false;

            for (const entry of entries.values()) {
                if (
                    cleanText(entry.url) ===
                    cleanText(release.releaseUrl) &&
                    String(entry.linkType) === wantedType
                ) {
                    alreadyExists = true;
                    break;
                }
            }

            if (alreadyExists) {
                continue;
            }

            let nextIndex = 0;

            if (entries.size) {
                nextIndex =
                    Math.max(
                        ...entries.keys()
                    ) + 1;
            }

            const urlInput =
                createHiddenInput(
                    form,
                    `urls.${nextIndex}.url`,
                    release.releaseUrl
                );

            const typeInput =
                createHiddenInput(
                    form,
                    `urls.${nextIndex}.link_type`,
                    wantedType
                );

            urlInput.dataset.hbrBeatport = 'true';
            typeInput.dataset.hbrBeatport = 'true';
        }

        console.log(
            '[Harmony Beatport Recovery] ' +
            'Seeded Beatport purchase + streaming relationships:',
            release.releaseUrl
        );
    }

    function injectBeatportIntoEditNote(form, release) {
        if (!release.releaseUrl) {
            return;
        }

        const editNote =
            form.querySelector(
                'input[name="edit_note"], textarea[name="edit_note"]'
            );

        if (!editNote) {
            return;
        }

        const beatportLine =
            `* Beatport: ${release.releaseUrl}`;

        if (
            editNote.value.includes(
                beatportLine
            )
        ) {
            return;
        }

        let value =
            editNote.value || '';

        if (
            value.length &&
            !value.endsWith('\n')
        ) {
            value += '\n';
        }

        value += beatportLine;

        editNote.value = value;

        console.log(
            '[Harmony Beatport Recovery] Added Beatport to edit note.'
        );
    }

    function patchMusicBrainzSeedForm(form, release) {
        if (!form || !release) {
            return;
        }

        const formName =
            form.getAttribute('name');

        if (
            formName !== 'release-seeder' &&
            formName !== 'release-update-seeder'
        ) {
            return;
        }

        /*
         * Both forms get Beatport external URLs + edit-note source.
         */
        injectBeatportUrlIntoSeed(
            form,
            release
        );

        injectBeatportIntoEditNote(
            form,
            release
        );

        /*
         * Only the full release importer gets the Beatport catalog number.
         */
        if (formName === 'release-seeder') {
            injectCatalogNumberIntoReleaseSeed(
                form,
                release
            );
        }
    }

    function patchAllMusicBrainzSeedForms(release) {
        const forms =
            document.querySelectorAll(
                'form[name="release-seeder"], ' +
                'form[name="release-update-seeder"]'
            );

        for (const form of forms) {
            patchMusicBrainzSeedForm(
                form,
                release
            );
        }
    }

    function setupSeederSubmitProtection() {
        /*
         * Reapply immediately before submission in case Harmony or another
         * userscript has replaced any of the hidden inputs.
         */
        document.addEventListener(
            'submit',
            event => {
                if (
                    !activeBeatportResult?.release
                ) {
                    return;
                }

                const form = event.target;

                if (!(form instanceof HTMLFormElement)) {
                    return;
                }

                patchMusicBrainzSeedForm(
                    form,
                    activeBeatportResult.release
                );
            },
            true
        );
    }

    // =========================================================================
    // HARMONY — SUCCESS MESSAGE
    // =========================================================================

    function convertBeatportMessageToSuccess(release) {
        const message = findBeatportMessage();

        if (!message) {
            return;
        }

        message.dataset.hbrRecovered = 'true';

        message.classList.remove('error');

        Object.assign(message.style, {
            borderColor: '#4CAF50'
        });

        const content =
            getBeatportMessageContent(message);

        content.replaceChildren();

        const status =
            document.createElement('p');

        const statusStrong =
            document.createElement('strong');

        statusStrong.textContent =
            'Beatport data recovered';

        status.appendChild(
            statusStrong
        );

        const details =
            document.createElement('div');

        const addLine = (
            label,
            value,
            options = {}
        ) => {
            if (
                value === null ||
                value === undefined ||
                value === ''
            ) {
                return;
            }

            const line =
                document.createElement('div');

            const strong =
                document.createElement('strong');

            strong.textContent =
                `${label}: `;

            line.appendChild(strong);

            if (options.url) {
                const link =
                    document.createElement('a');

                link.href =
                    options.url;

                link.target =
                    '_blank';

                link.rel =
                    'noopener noreferrer';

                link.textContent =
                    String(value);

                line.appendChild(link);
            } else {
                line.appendChild(
                    document.createTextNode(
                        String(value)
                    )
                );
            }

            details.appendChild(line);
        };

        addLine(
            'Release',
            release.releaseName
        );

        addLine(
            'Artist',
            release.artists
                .map(a => a.name)
                .filter(Boolean)
                .join(', ')
        );

        addLine(
            'UPC',
            release.upc
        );

        addLine(
            'Catalog number',
            release.catalogNumber
        );

        addLine(
            'Label',
            release.label?.name
        );

        addLine(
            'Beatport release',
            release.releaseId,
            {
                url: release.releaseUrl
            }
        );

        content.append(
            status,
            details
        );

        const retryButton =
            createHarmonyButton();

        retryButton.textContent =
            'Search Beatport again';

        content.appendChild(
            retryButton
        );
    }

    // =========================================================================
    // HARMONY — APPLY RESULT
    // =========================================================================

    function applyBeatportResult(result) {
        if (
            !result ||
            result.status !== 'success' ||
            !result.release
        ) {
            return;
        }

        const currentBarcode =
            getHarmonyBarcode();

        if (
            !currentBarcode ||
            normalizeBarcode(currentBarcode) !==
            normalizeBarcode(result.request?.barcode)
        ) {
            console.warn(
                '[Harmony Beatport Recovery] ' +
                'Ignoring stored result because the currently rendered ' +
                'Harmony UPC does not match it.',
                {
                    currentBarcode,
                    resultBarcode:
                        result.request?.barcode
                }
            );

            return;
        }

        activeBeatportResult = result;

        patchAllMusicBrainzSeedForms(
            result.release
        );

        const releaseContainer =
            document.querySelector('.release');

        const resultMarker =
            `${result.requestId}:${result.timestamp}`;

        if (
            releaseContainer?.dataset
                .hbrAppliedResult ===
            resultMarker
        ) {
            return;
        }

        console.log(
            '[Harmony Beatport Recovery] Applying Beatport result:',
            result
        );

        convertBeatportMessageToSuccess(
            result.release
        );

        injectBeatportProvider(
            result.release
        );

        injectBeatportLabelAlternative(
            result.release
        );

        if (releaseContainer) {
            releaseContainer.dataset
                .hbrAppliedResult =
                resultMarker;
        }
    }

    // =========================================================================
    // HARMONY — INITIALIZATION
    // =========================================================================

    async function restoreExistingResult() {
        const result =
            await GM_getValue(
                RESULT_KEY,
                null
            );

        if (result?.status === 'success') {
            applyBeatportResult(
                result
            );
        }
    }

    function setupResultListener() {
        GM_addValueChangeListener(
            RESULT_KEY,
            (
                name,
                oldValue,
                newValue,
                remote
            ) => {
                if (
                    !newValue ||
                    newValue.status !== 'success'
                ) {
                    return;
                }

                applyBeatportResult(
                    newValue
                );
            }
        );
    }

    function initHarmony() {
        addHarmonyButton();

        setupResultListener();

        setupSeederSubmitProtection();

        restoreExistingResult();

        const observer =
            new MutationObserver(() => {
                addHarmonyButton();

                if (activeBeatportResult?.release) {
                    patchAllMusicBrainzSeedForms(
                        activeBeatportResult.release
                    );

                    return;
                }

                GM_getValue(
                    RESULT_KEY,
                    null
                ).then(result => {
                    if (
                        result?.status === 'success'
                    ) {
                        applyBeatportResult(
                            result
                        );
                    }
                });
            });

        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );
    }

    // =========================================================================
    // BEATPORT — EMBEDDED DATA EXTRACTION
    // =========================================================================

    function findReleaseObjects(root) {
        const results = [];
        const seen = new Set();

        function walk(value) {
            if (
                !value ||
                typeof value !== 'object'
            ) {
                return;
            }

            if (seen.has(value)) {
                return;
            }

            seen.add(value);

            if (
                !Array.isArray(value) &&
                value.release_id != null &&
                value.upc != null
            ) {
                results.push(value);
            }

            if (Array.isArray(value)) {
                for (const item of value) {
                    walk(item);
                }
            } else {
                for (
                    const child
                    of Object.values(value)
                ) {
                    walk(child);
                }
            }
        }

        walk(root);

        return results;
    }

    function extractBeatportReleases() {
        const unique = new Map();

        for (
            const script
            of document.querySelectorAll('script')
        ) {
            const text =
                script.textContent?.trim();

            if (!text) {
                continue;
            }

            if (
                !text.startsWith('{') &&
                !text.startsWith('[')
            ) {
                continue;
            }

            try {
                const parsed =
                    JSON.parse(text);

                const found =
                    findReleaseObjects(parsed);

                for (
                    const release
                    of found
                ) {
                    const key =
                        `${release.release_id}:${release.upc}`;

                    if (!unique.has(key)) {
                        unique.set(
                            key,
                            release
                        );
                    }
                }

            } catch {
                /*
                 * Ordinary JavaScript or another non-JSON script.
                 */
            }
        }

        return Array.from(
            unique.values()
        );
    }

    function findMatchingRelease(
        releases,
        barcode
    ) {
        const target =
            normalizeBarcode(barcode);

        return releases.filter(
            release =>
                normalizeBarcode(
                    release.upc
                ) === target
        );
    }

    function makeReleaseUrl(release) {
        return (
            'https://www.beatport.com/release/' +
            `${slugify(
                release.release_name || 'release'
            )}/${release.release_id}`
        );
    }

    function simplifyRelease(release) {
        return {
            releaseId:
                release.release_id ?? null,

            releaseName:
                release.release_name ?? null,

            upc:
                release.upc ?? null,

            catalogNumber:
                release.catalog_number ?? null,

            label: release.label
                ? {
                    id:
                        release.label.label_id ??
                        null,

                    name:
                        release.label.label_name ??
                        null
                }
                : null,

            artists:
                Array.isArray(release.artists)
                    ? release.artists.map(
                        artist => ({
                            id:
                                artist.artist_id ??
                                null,

                            name:
                                artist.artist_name ??
                                null,

                            type:
                                artist.artist_type_name ??
                                null
                        })
                    )
                    : [],

            aggregator:
                release.aggregator
                    ? {
                        id:
                            release.aggregator
                                .aggregator_id ??
                            null,

                        name:
                            release.aggregator
                                .aggregator_name ??
                            null
                    }
                    : null,

            genres:
                Array.isArray(release.genre)
                    ? release.genre.map(
                        genre => ({
                            id:
                                genre.genre_id ??
                                null,

                            name:
                                genre.genre_name ??
                                null
                        })
                    )
                    : [],

            tracks:
                Array.isArray(release.tracks)
                    ? release.tracks.map(
                        track => ({
                            id:
                                track.track_id ??
                                null,

                            name:
                                track.track_name ??
                                null
                        })
                    )
                    : [],

            keys:
                Array.isArray(release.key)
                    ? release.key.map(
                        key => ({
                            id:
                                key.key_id ??
                                null,

                            name:
                                key.key_name ??
                                null
                        })
                    )
                    : [],

            releaseDate:
                release.release_date ??
                null,

            publishDate:
                release.publish_date ??
                null,

            preorderDate:
                release.pre_order_date ??
                null,

            exclusiveDate:
                release.exclusive_date ??
                null,

            trackCount:
                release.track_count ??
                null,

            availableWorldwide:
                release.available_worldwide ??
                null,

            image:
                release.release_image_uri ??
                null,

            price:
                release.price ??
                null,

            releaseUrl:
                makeReleaseUrl(
                    release
                ),

            raw:
                release
        };
    }

    // =========================================================================
    // BEATPORT — FAILURE / DIAGNOSTIC PANEL
    // =========================================================================

    function createDebugPanel(
        request,
        result
    ) {
        document
            .getElementById(DEBUG_PANEL_ID)
            ?.remove();

        const panel =
            document.createElement('div');

        panel.id =
            DEBUG_PANEL_ID;

        Object.assign(
            panel.style,
            {
                position: 'fixed',
                top: '20px',
                right: '20px',
                width: '420px',
                maxHeight: '80vh',
                overflow: 'auto',
                zIndex: '2147483647',
                background: '#181818',
                color: '#fff',
                border: '2px solid #ff9800',
                borderRadius: '8px',
                padding: '14px',
                boxShadow:
                    '0 4px 20px rgba(0,0,0,.65)',
                fontFamily:
                    'Arial, sans-serif',
                fontSize: '13px',
                lineHeight: '1.4'
            }
        );

        const heading =
            document.createElement('div');

        heading.textContent =
            'Harmony Beatport Recovery';

        Object.assign(
            heading.style,
            {
                color: '#ff9800',
                fontWeight: 'bold',
                fontSize: '16px',
                marginBottom: '10px'
            }
        );

        panel.appendChild(
            heading
        );

        const addRow = (
            label,
            value
        ) => {
            const row =
                document.createElement('div');

            row.style.marginBottom =
                '5px';

            const strong =
                document.createElement('strong');

            strong.textContent =
                `${label}: `;

            row.append(
                strong,
                document.createTextNode(
                    value == null
                        ? '—'
                        : String(value)
                )
            );

            panel.appendChild(
                row
            );
        };

        addRow(
            'Harmony title',
            request.title
        );

        addRow(
            'Harmony artist',
            request.artist
        );

        addRow(
            'Target UPC',
            request.barcode
        );

        const divider =
            document.createElement('hr');

        divider.style.borderColor =
            '#555';

        panel.appendChild(
            divider
        );

        addRow(
            'Status',
            result.message
        );

        document.body.appendChild(
            panel
        );
    }

    // =========================================================================
    // BEATPORT — AUTOMATION
    // =========================================================================

    async function processBeatportPage() {
        const requestId =
            new URL(location.href)
                .searchParams
                .get('hbr');

        /*
         * No HBR marker = ordinary Beatport browsing.
         */
        if (!requestId) {
            return;
        }

        const request =
            await GM_getValue(
                REQUEST_KEY,
                null
            );

        if (
            !request ||
            request.requestId !== requestId
        ) {
            console.log(
                '[Harmony Beatport Recovery] ' +
                'No matching active Harmony request. ' +
                'Leaving Beatport alone.'
            );

            return;
        }

        console.log(
            '[Harmony Beatport Recovery] Active request:',
            request
        );

        let releases = [];

        for (
            let attempt = 1;
            attempt <= 20;
            attempt++
        ) {
            releases =
                extractBeatportReleases();

            if (releases.length) {
                break;
            }

            await sleep(500);
        }

        console.log(
            '[Harmony Beatport Recovery] ' +
            `Found ${releases.length} release objects.`
        );

        const matches =
            findMatchingRelease(
                releases,
                request.barcode
            );

        console.log(
            '[Harmony Beatport Recovery] UPC matches:',
            matches
        );

        // ---------------------------------------------------------------------
        // EXACTLY ONE MATCH = SUCCESS
        // ---------------------------------------------------------------------

        if (matches.length === 1) {
            const release =
                simplifyRelease(
                    matches[0]
                );

            const result = {
                requestId:
                    request.requestId,

                timestamp:
                    Date.now(),

                status:
                    'success',

                request,

                release
            };

            await GM_setValue(
                RESULT_KEY,
                result
            );

            await GM_deleteValue(
                REQUEST_KEY
            );

            console.log(
                '[Harmony Beatport Recovery] Exact UPC match:',
                release
            );

            console.log(
                '[Harmony Beatport Recovery] Returning result to Harmony ' +
                'and closing Beatport tab.'
            );

            window.close();

            return;
        }

        // ---------------------------------------------------------------------
        // MULTIPLE UPC MATCHES
        // ---------------------------------------------------------------------

        if (matches.length > 1) {
            const result = {
                requestId:
                    request.requestId,

                timestamp:
                    Date.now(),

                status:
                    'ambiguous',

                request,

                matches:
                    matches.map(
                        simplifyRelease
                    ),

                message:
                    `Found ${matches.length} Beatport releases with UPC ` +
                    request.barcode +
                    '. The tab was left open for review.'
            };

            await GM_setValue(
                RESULT_KEY,
                result
            );

            createDebugPanel(
                request,
                result
            );

            return;
        }

        // ---------------------------------------------------------------------
        // NO UPC MATCH
        // ---------------------------------------------------------------------

        const result = {
            requestId:
                request.requestId,

            timestamp:
                Date.now(),

            status:
                'not-found',

            request,

            message:
                'No Beatport release with the exact Harmony UPC ' +
                `${request.barcode} was found. ` +
                'The tab was left open for review.'
        };

        await GM_setValue(
            RESULT_KEY,
            result
        );

        createDebugPanel(
            request,
            result
        );
    }

    // =========================================================================
    // ENTRY POINT
    // =========================================================================

    function init() {
        if (isHarmony()) {
            initHarmony();
            return;
        }

        if (isBeatport()) {
            processBeatportPage();
        }
    }

    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            init,
            {
                once: true
            }
        );
    } else {
        init();
    }

})();
