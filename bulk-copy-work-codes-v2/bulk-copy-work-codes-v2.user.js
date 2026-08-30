// ==UserScript==
// @name         MusicBrainz: Bulk copy-paste work codes V2
// @version      2.0.0
// @description  Copy work identifiers from various online repertoires and paste them into MB works with ease.
// @author       ROpdebee; modifications by djkhjg
// @license      MIT; https://opensource.org/licenses/MIT
// @namespace    https://github.com/ROpdebee/mb-userscripts
// @homepageURL  https://github.com/ROpdebee/mb-userscripts
// @supportURL   https://github.com/djkhjg/musicbrainz-userscripts/issues
// @downloadURL  https://raw.github.com/djkhjg/musicbrainz-userscripts/main/bulk-copy-work-codes-v2/bulk-copy-work-codes-rev2.user.js
// @updateURL    https://raw.github.com/djkhjg/musicbrainz-userscripts/main/bulk-copy-work-codes-v2/bulk-copy-work-codes-rev2.user.js
// @match        https://iswcnet.cisac.org/*
// @match        https://online.gema.de/werke/search.faces*
// @match        https://repertoire.bmi.com/*
// @match        https://www.ascap.com/repertory*
// @match        https://ascap.com/repertory*
// @match        *://musicbrainz.org/*/edit
// @match        *://*.musicbrainz.org/*/edit
// @match        *://musicbrainz.org/release/*/edit-relationships
// @match        *://*.musicbrainz.org/release/*/edit-relationships
// @match        *://musicbrainz.org/*/create
// @match        *://*.musicbrainz.org/*/create
// @require      https://raw.github.com/ROpdebee/mb-userscripts/main/lib/work_identifiers.js?v=2025.03.09
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_info
// ==/UserScript==

// Credit to ROpdebee for original script, I just fixed a bug and added some more supported sources
// https://github.com/ROpdebee/mb-userscripts/blob/main/mb_bulk_copy_work_codes.user.js

//////////////
// Utils
//////////////

// Taken from https://stackoverflow.com/a/44622467
class DefaultDict {
    constructor(defaultInit) {
        return new Proxy({}, {
            get: (target, name) => name in target ?
            target[name] :
            (target[name] = typeof defaultInit === 'function' ?
             new defaultInit().valueOf() :
             defaultInit)
        });
    }
}


Array.prototype.groupBy = function(keyFn, valTransform) {
    return Object.assign({}, this.reduce(
        (acc, el) => {
            acc[keyFn(el)].push((valTransform || (e => e))(el));
            return acc;
        },
        new DefaultDict(Array)
    ));
};

Array.prototype.intersect = function(other) {
    return this.filter(el => other.includes(el));
};

Array.prototype.difference = function(other) {
    return this.filter(el => !other.includes(el));
};

function findDivByText(parent, text) {
    let divs = [...parent.querySelectorAll("div")];
    return divs.filter(n => n.innerText === text);
}


//////////////
// MB
//////////////

const LOG_STYLES = {
    'error': 'background-color: FireBrick; color: white; font-weight: bold;',
    'warning': 'background-color: Gold;',
    'info': 'background-color: GainsBoro;',
    'success': 'background-color: LightGreen;',
};

function normaliseID(id, agencyKey) {
    let formatResult = MBWorkIdentifiers.validateCode(id, agencyKey);

    if (!formatResult.isValid) {
        return id.replace(/(?:^0+|[\.\s-])/g, '');
    }

    return formatResult.formattedCode;
}

/**
 * Convert translated agency IDs into English variant.
 * TODO: There needs to be a better way to do this without hardcoding...
 */
function normaliseAgencyId(agencyId) {
    return agencyId
        .replace(/-ID$/, ' ID')
        .replace(/^ID (.+)/, '$1 ID')
        .replace(/-tunniste$/, ' ID');
}

function getSelectedID(select) {
    return normaliseAgencyId(
        select.options[select.selectedIndex].text.trim()
    );
}

function setRowKey(select, agencyKey) {
    let idx = [...select.options].findIndex(
        opt => normaliseAgencyId(opt.text.trim()) === agencyKey
    );

    if (idx < 0) {
        throw new Error('Unknown agency key');
    }

    select.selectedIndex = idx;
}

function computeAgencyConflicts(mbCodes, extCodes) {
    let commonKeys =
        Object.keys(mbCodes)
    .intersect(Object.keys(extCodes));

    return commonKeys
        .filter(k => mbCodes[k].length)
        .filter(k =>
                extCodes[k]
                .map(c => normaliseID(c, k))
                .difference(
        mbCodes[k].map(
            c => normaliseID(c, k)
        )
    )
                .length
               )
        .map(
        k => [
            k,
            mbCodes[k],
            extCodes[k]
        ]
    );
}

function extractCodes(data) {
    let agencyCodes =
        data['agencyCodes'] || {};

    return Object.entries(agencyCodes).reduce(
        (acc, [key, codes]) => {
            acc[
                MBWorkIdentifiers.agencyNameToID(key)
            ] = codes;

            return acc;
        },
        {}
    );
}

function deduplicateCodes(codes, key) {
    const seen = new Set();
    const results = [];

    for (const code of codes) {
        if (
            seen.has(
                normaliseID(code, key)
            )
        ) {
            continue;
        }

        seen.add(
            normaliseID(code, key)
        );

        results.push(code);
    }

    return results;
}

function fillInput(inp, val) {
    inp.value = val;
    inp.style.backgroundColor = 'yellow';
}


// Style and concept by loujine
// https://github.com/loujine/musicbrainz-scripts/blob/master/mbz-loujine-common.js
const mainUIHTML = `<div id="ropdebee-work-menu"
        style="background-color: white;
        padding: 8px; margin: 0px -6px 6px 550px;
        border: 5px dotted rgb(115, 109, 171);">
    <h2>ROpdebee's work code tools</h2><br/>
    <div class="buttons">
        <button type="button" id="ROpdebee_MB_Paste_Work"
                title="Fill work codes from previously copied agency data."
                style="cursor: help;"
            >Fill work codes</button>
        <button type="button" id="ROpdebee_MB_Format_Codes"
                title="Correct work code formatting (EXPERIMENTAL)."
                style="cursor: help;"
            >Format work codes</button>
        <input type="checkbox" id="ROpdebee_MB_Autoformat_Codes">
        <label for="ROpdebee_MB_Autoformat_Codes">
            Automatically format work codes on paste (EXPERIMENTAL)
        </label>
    </div>
    <div id="ROpdebee_MB_Paste_Work_Log"
         style="display: none; max-height: 100px; overflow: auto;">
        <h3>Log</h3>
    </div>
    <div id="ROpdebee_MB_Code_Validation_Errors"
         style="display: none;">
        <h3>Validation errors</h3>
    </div>
</div>`;


class BaseWorkForm {
    constructor(theForm) {
        this.form = theForm;
        this.form.ROpdebee_Work_Codes_Found = true;

        this.addToolsUI();
        this.activateButtons();
        this.checkExistingCodes();
    }

    activateButtons() {
        this.form
            .querySelector(
            'button#ROpdebee_MB_Paste_Work'
        )
            .addEventListener(
            'click',
            evt => {
                evt.preventDefault();

                this.resetLog();

                this.readData(
                    this.checkAndFill.bind(this)
                );
            }
        );

        this.form
            .querySelector(
            'button#ROpdebee_MB_Format_Codes'
        )
            .addEventListener(
            'click',
            evt => {
                evt.preventDefault();

                this.resetLog();

                let formattedAny =
                    this.formatExistingCodes();

                if (formattedAny) {
                    this.fillEditNote(
                        [],
                        'Existing MusicBrainz data',
                        null,
                        null,
                        true
                    );
                }
            }
        );

        let autoFormatCheckbox =
            this.form.querySelector(
                'input#ROpdebee_MB_Autoformat_Codes'
            );

        autoFormatCheckbox.addEventListener(
            'change',
            evt => {
                evt.preventDefault();

                if (
                    evt.currentTarget.checked
                ) {
                    localStorage.setItem(
                        evt.currentTarget.id,
                        'delete me to disable'
                    );
                } else {
                    localStorage.removeItem(
                        evt.currentTarget.id
                    );
                }
            }
        );

        autoFormatCheckbox.checked =
            !!localStorage.getItem(
            'ROpdebee_MB_Autoformat_Codes'
        );
    }

    checkExistingCodes() {
        this.resetValidationLog();

        this.existingCodeInputs.forEach(
            ({ select, input }) => {
                let agencyKey =
                    getSelectedID(select);

                let agencyCode =
                    input.value;

                let checkResult =
                    MBWorkIdentifiers.validateCode(
                        agencyCode,
                        agencyKey
                    );

                if (
                    !checkResult.isValid
                ) {
                    input.style.backgroundColor =
                        'red';

                    this.addValidationError(
                        agencyKey,
                        agencyCode,
                        checkResult.message
                    );
                } else if (
                    checkResult.wasChanged
                ) {
                    input.style.backgroundColor =
                        'orange';

                    this.addFormatWarning(
                        agencyKey,
                        agencyCode
                    );
                }
            }
        );
    }

    formatExistingCodes() {
        let formattedAny = false;

        this.existingCodeInputs.forEach(
            ({ select, input }) => {
                let agencyKey =
                    getSelectedID(select);

                let agencyCode =
                    input.value;

                let checkResult =
                    MBWorkIdentifiers.validateCode(
                        agencyCode,
                        agencyKey
                    );

                if (
                    checkResult.isValid &&
                    checkResult.wasChanged
                ) {
                    fillInput(
                        input,
                        checkResult.formattedCode
                    );

                    this.log(
                        'info',
                        `Changed ${agencyKey} ${agencyCode} to ${checkResult.formattedCode}`
                    );

                    formattedAny = true;
                }
            }
        );

        return formattedAny;
    }

    resetLog() {
        let logDiv =
            this.form.querySelector(
                'div#ROpdebee_MB_Paste_Work_Log'
            );

        logDiv.style.display =
            'none';

        [...logDiv.children]
            .slice(1)
            .forEach(
            el => el.remove()
        );
    }

    resetValidationLog() {
        let logDiv =
            this.form.querySelector(
                'div#ROpdebee_MB_Code_Validation_Errors'
            );

        logDiv.style.display =
            'none';

        [...logDiv.children]
            .slice(1)
            .forEach(
            el => el.remove()
        );
    }

    get autoformatCodes() {
        return this.form
            .querySelector(
            'input#ROpdebee_MB_Autoformat_Codes'
        )
            .checked;
    }

    get existingCodeInputs() {
        return [
            ...this.form.querySelectorAll(
                'table#work-attributes tr'
            )
        ]
            .map(
            row => ({
                select:
                row.querySelector(
                    'td > select'
                ),

                input:
                row.querySelector(
                    'td > input'
                ),
            })
        )
            .filter(
            ({ select, input }) =>
            select !== null &&
            select.selectedIndex !== 0 &&
            input !== null &&
            input.value
        );
    }

    get existingCodes() {
        return this.existingCodeInputs
            .groupBy(
            ({ select }) =>
            getSelectedID(select),

            ({ input: { value } }) =>
            value
        );
    }

    get existingISWCs() {
        return [
            ...this.form.querySelectorAll(
                'input[name^="edit-work.iswcs."]'
            )
        ]
            .map(
            ({ value }) => value
        )
            .filter(
            ({ length }) => length
        );
    }

    async findEmptyRow(
    parentSelector,
     inputName
    ) {
        const parent =
              this.form.querySelector(
                  parentSelector
              );

        if (!parent) {
            throw new Error(
                `Could not find parent container ${parentSelector}`
            );
        }

        const getEmptyRow = () => {
            const rows = [
                ...parent.querySelectorAll(
                    'input[name*="' +
                    inputName +
                    '"]'
                )
            ];

            return rows.find(
                ({ value }) =>
                !value.length
            ) || null;
        };

        const existingEmptyRow =
              getEmptyRow();

        if (existingEmptyRow) {
            return existingEmptyRow;
        }

        const newRowBtn =
              parent.querySelector(
                  'button.add-item'
              );

        if (!newRowBtn) {
            throw new Error(
                `Could not find add-row button for ${inputName}`
            );
        }

        return new Promise(
            (resolve, reject) => {
                let settled = false;

                const finish =
                      input => {
                          if (settled) {
                              return;
                          }

                          settled = true;

                          observer.disconnect();
                          clearTimeout(timeout);

                          resolve(input);
                      };

                const checkForRow =
                      () => {
                          const input =
                                getEmptyRow();

                          if (input) {
                              finish(input);
                          }
                      };

                const observer =
                      new MutationObserver(
                          checkForRow
                      );

                observer.observe(
                    parent,
                    {
                        subtree: true,
                        childList: true,
                    }
                );

                const timeout =
                      setTimeout(
                          () => {
                              if (settled) {
                                  return;
                              }

                              settled = true;

                              observer.disconnect();

                              reject(
                                  new Error(
                                      `Timed out waiting for MusicBrainz to add a row for ${inputName}`
                                  )
                              );
                          },
                          5000
                      );

                newRowBtn.click();
                checkForRow();
            }
        );
    }

    async checkAndFill(rawData) {
        let data =
            this.parseData(rawData);

        console.log(data);

        let externalCodes =
            extractCodes(data);

        let externalISWCs = [
            ...new Set(
                (data['iswcs'] || [])
                .map(
                    iswc =>
                    iswc.trim()
                )
                .filter(Boolean)
            )
        ];

        let mbCodes =
            this.existingCodes;

        let mbISWCs =
            this.existingISWCs;

        let dupeAgencies =
            Object.entries(
                externalCodes
            )
        .filter(
            ([key, codes]) =>
            codes.length > 1
        )
        .map(
            ([key]) => key
        );

        if (
            dupeAgencies.length
        ) {
            const lis =
                  dupeAgencies.reduce(
                      (acc, agency) =>
                      acc +
                      `<li>${agency}: ${externalCodes[agency].join(', ')}</li>`,

                      ''
                  );

            this.log(
                'warning',
                `
                Found duplicate work codes in input.
                Please double-check whether all of these codes belong to this work.
                <ul>${lis}</ul>`
            );
        }

        let newISWCs =
            externalISWCs.difference(
                mbISWCs
            );

        let conflicts =
            computeAgencyConflicts(
                mbCodes,
                externalCodes
            );

        if (
            newISWCs.length &&
            mbISWCs.length
        ) {
            conflicts.unshift(
                [
                    'ISWC',
                    mbISWCs,
                    externalISWCs
                ]
            );
        }

        let confirmProm =
            conflicts.length
        ? this.promptForConfirmation(
            conflicts
        )
        : Promise.resolve();

        await confirmProm;

        let newCodes =
            this.retainOnlyNew(
                externalCodes,
                mbCodes
            );

        await this.fillData(
            newISWCs,
            newCodes,
            data['title'],
            data['source'],
            data['sourceUrl'],
            data['sourceReference']
        );

        let numWarnings =
            this.form.querySelectorAll(
                'div#ROpdebee_MB_Paste_Work_Log > div'
            ).length;

        this.log(
            'success',
            'Filled successfully' +
            (
                numWarnings
                ? ` (${numWarnings} message(s))`
                : ''
            )
        );
    }

    retainOnlyNew(
    externalCodes,
     mbCodes
    ) {
        return Object.entries(
            externalCodes
        ).reduce(
            (
                acc,
                [key, rawCodes]
            ) => {
                const codes =
                      deduplicateCodes(
                          rawCodes,
                          key
                      );

                if (
                    !mbCodes.hasOwnProperty(
                        key
                    )
                ) {
                    acc[key] =
                        codes;
                } else {
                    const mbNormCodes =
                          mbCodes[key].map(
                              c =>
                              normaliseID(
                                  c,
                                  key
                              )
                          );

                    acc[key] =
                        codes.filter(
                        id =>
                        !mbNormCodes.includes(
                            normaliseID(
                                id,
                                key
                            )
                        )
                    );
                }

                return acc;
            },
            {}
        );
    }

    async fillData(
    iswcs,
     codes,
     title,
     source,
     sourceUrl,
     sourceReference
    ) {
        for (
            const iswc of iswcs
        ) {
            await this.fillISWC(
                iswc
            );
        }

        let entries =
            Object.entries(codes);

        entries.sort();

        let unknownAgencyCodes =
            [];

        for (
            const [
                agencyKey,
                agencyCodes
            ] of entries
        ) {
            try {
                await this.fillAgencyCodes(
                    agencyKey,
                    agencyCodes
                );
            } catch (e) {
                if (
                    e.message ===
                    'Unknown agency key'
                ) {
                    unknownAgencyCodes.push(
                        [
                            agencyKey,
                            agencyCodes
                        ]
                    );
                } else {
                    throw e;
                }
            }
        }

        if (
            unknownAgencyCodes.length
        ) {
            const lis =
                  unknownAgencyCodes.reduce(
                      (
                          acc,
                          [agency, codes]
                      ) =>
                      acc +
                      `<li>${agency}: ${codes.join(', ')}</li>`,

                      ''
                  );

            this.log(
                'warning',
                `
                Encountered unsupported agencies.
                If you encounter these a lot, please consider filing a ticket.
                <ul>${lis}</ul>`
            );
        }

        if (
            this.autoformatCodes
        ) {
            this.formatExistingCodes();
        }

        this.checkExistingCodes();

        this.maybeFillTitle(
            title
        );

        this.fillEditNote(
            unknownAgencyCodes,
            source,
            sourceUrl,
            sourceReference,
            this.autoformatCodes
        );
    }

    maybeFillTitle(title) {
        if (!title) {
            return;
        }

        let titleInp =
            this.form.querySelector(
                'input[name="edit-work.name"]'
            );

        if (
            !titleInp ||
            titleInp.value
        ) {
            return;
        }

        fillInput(
            titleInp,
            title.toLowerCase()
        );

        const guessButton =
              titleInp
        .closest('div.row')
        ?.querySelector(
            'button.guesscase-title'
        );

        if (guessButton) {
            guessButton.click();
        }
    }

    async fillISWC(iswc) {
        let row =
            await this.findEmptyRow(
                'div.form-row-text-list',
                'edit-work.iswcs.'
            );

        fillInput(
            row,
            iswc
        );
    }

    async fillAgencyCodes(
    agencyKey,
     agencyCodes
    ) {
        for (
            const code of agencyCodes
        ) {
            let input =
                await this.findEmptyRow(
                    'table#work-attributes',
                    'edit-work.attributes.'
                );

            setRowKey(
                input
                .closest('tr')
                .querySelector(
                    'td > select'
                ),
                agencyKey
            );

            fillInput(
                input,
                code
            );
        }
    }

    fillEditNote(
    unknownAgencies,
     source,
     sourceUrl,
     sourceReference,
     wasFormatted
    ) {
        let noteContent =
            unknownAgencies.reduce(
                (
                    acc,
                    [
                        agencyKey,
                        agencyCodes
                    ]
                ) =>
                acc +
                agencyKey +
                ': ' +
                agencyCodes.join(', ') +
                '\n',

                unknownAgencies.length
                ? 'Unsupported agencies:\n'
                : ''
            );

        let sourceContent = '';

        if (source) {
            sourceContent +=
                `Source: ${source}\n`;

            if (sourceReference) {
                sourceContent +=
                    `${sourceReference}\n`;
            }

            if (sourceUrl) {
                sourceContent +=
                    `${sourceUrl}\n`;
            }
        }

        if (sourceContent) {
            sourceContent += '\n';
        }

        if (noteContent) {
            sourceContent +=
                noteContent +
                '\n';
        }

        if (sourceContent) {
            this.fillEditNoteTop(
                sourceContent
            );
        }

        let fmtAppliedStr =
            wasFormatted
        ? MBWorkIdentifiers.VERSION
        : 'not applied';

        let editNoteBottom =
            `${GM_info.script.name} v${GM_info.script.version} ` +
            `(formatting: ${fmtAppliedStr})`;

        this.fillEditNoteBottom(
            editNoteBottom
        );
    }

    fillEditNoteTop(content) {
        let note =
            this.form.querySelector(
                'textarea[name="edit-work.edit_note"]'
            );

        let noteParts =
            note.value.split(
                '–\n'
            );

        let top =
            noteParts[0];

        if (!top) {
            top =
                content;
        } else {
            if (
                !top.endsWith('\n')
            ) {
                top += '\n';
            }

            top += content;
        }

        noteParts[0] =
            top;

        note.value =
            noteParts.join(
            '–\n'
        );
    }

    fillEditNoteBottom(content) {
        let note =
            this.form.querySelector(
                'textarea[name="edit-work.edit_note"]'
            );

        let noteParts =
            note.value.split(
                '–\n'
            );

        let bottom =
            noteParts[1];

        if (!bottom) {
            bottom =
                content;
        } else {
            bottom +=
                '\n' +
                content;
        }

        noteParts[0] =
            noteParts[0]
            ? noteParts[0]
        : '\n';

        noteParts[1] =
            bottom;

        note.value =
            noteParts.join(
            '–\n'
        );
    }

    readData(cb) {
        let data =
            GM_getValue(
                'workCodeData'
            );

        if (!data) {
            this.log(
                'error',
                'No data found. Did you copy anything?'
            );

            return;
        }

        cb(data);

        GM_deleteValue(
            'workCodeData'
        );
    }

    parseData(raw) {
        try {
            return JSON.parse(
                raw
            );
        } catch (e) {
            this.log(
                'error',
                'Invalid data'
            );

            console.log(raw);
            console.log(e);

            return {};
        }
    }

    promptForConfirmation(
    conflicts
    ) {
        const lis =
              conflicts.reduce(
                  (
                      acc,
                      [
                          agency,
                          mbCodes,
                          extCodes
                      ]
                  ) =>
                  acc +
                  `<li>${agency}: ` +
                  `[${mbCodes.join(', ')}] vs ` +
                  `[${extCodes.join(', ')}]</li>`,

                  ''
              );

        let msg =
            `Uh-oh. MB already has the following codes with conflicting data:
            Are you sure you want to fill these?
            Note: New codes will be added and will not replace the existing ones.<br/>
            <ul>${lis}</ul>
            <button type="button" class="conflict-confirm">Confirm</button>`;

        this.log(
            'warning',
            msg
        );

        return new Promise(
            resolve => {
                this.form
                    .querySelector(
                    '.conflict-confirm'
                )
                    .addEventListener(
                    'click',
                    evt => {
                        evt.target.disabled =
                            true;

                        evt.preventDefault();

                        resolve();
                    }
                );
            }
        );
    }

    log(level, html) {
        let logDiv =
            this.form.querySelector(
                'div#ROpdebee_MB_Paste_Work_Log'
            );

        logDiv.insertAdjacentHTML(
            'beforeend',
            `
            <div style="
                border: 1px dashed gray;
                padding: 2px 2px 5px 5px;
                margin-top: 2px;
                ${LOG_STYLES[level]}
            ">${html}</div>`
        );

        logDiv.style.display =
            'block';

        logDiv.scrollTop =
            logDiv.scrollHeight;
    }

    addValidationError(
    agencyKey,
     code,
     message
    ) {
        let logDiv =
            this.form.querySelector(
                'div#ROpdebee_MB_Code_Validation_Errors'
            );

        let msg =
            `${code} does not look like a valid ${agencyKey}.`;

        if (message) {
            msg +=
                ' ' +
                message;
        }

        logDiv.insertAdjacentHTML(
            'beforeend',
            `<div style="
                border: 1px dashed gray;
                padding: 2px 2px 5px 5px;
                margin-top: 2px;
                ${LOG_STYLES['error']}
            ">${msg}</div>`
        );

        logDiv.style.display =
            'block';

        logDiv.scrollTop =
            logDiv.scrollHeight;
    }

    addFormatWarning(
    agencyKey,
     code
    ) {
        let logDiv =
            this.form.querySelector(
                'div#ROpdebee_MB_Code_Validation_Errors'
            );

        let msg =
            `${code} is not a well-formatted ${agencyKey}.`;

        logDiv.insertAdjacentHTML(
            'beforeend',
            `<div style="
                border: 1px dashed gray;
                padding: 2px 2px 5px 5px;
                margin-top: 2px;
                ${LOG_STYLES['warning']}
            ">${msg}</div>`
        );

        logDiv.style.display =
            'block';

        logDiv.scrollTop =
            logDiv.scrollHeight;
    }
}


class WorkEditForm extends BaseWorkForm {
    addToolsUI() {
        this.form
            .querySelector(
            '.documentation'
        )
            .insertAdjacentHTML(
            'beforebegin',
            mainUIHTML
        );
    }
}


class IframeEditForm extends BaseWorkForm {
    addToolsUI() {
        this.form
            .querySelector(
            '.half-width'
        )
            .insertAdjacentHTML(
            'beforebegin',
            mainUIHTML
        );

        this.form
            .querySelector(
            '#ropdebee-work-menu'
        )
            .style['margin-left'] =
            0;
    }
}


function editFormFactory(
theForm,
 inIframe
) {
    if (inIframe) {
        return new IframeEditForm(
            theForm
        );
    }

    return new WorkEditForm(
        theForm
    );
}


function handleMB() {
    function handleChange() {
        let workForms = [
            ...document.querySelectorAll(
                'form.edit-work'
            )
        ].map(
            f => [f, false]
        );

        document
            .querySelectorAll(
            'iframe'
        )
            .forEach(
            iframe => {
                try {
                    iframe
                        .contentWindow
                        .document
                        .querySelectorAll(
                        'form.edit-work'
                    )
                        .forEach(
                        form =>
                        workForms.push(
                            [
                                form,
                                true
                            ]
                        )
                    );
                } catch (e) {
                    // Ignore cross-origin iframes.
                }
            }
        );

        workForms
            .filter(
            f =>
            !f[0]
            .ROpdebee_Work_Codes_Found
        )
            .forEach(
            (
                [
                    f,
                    inIframe
                ]
            ) =>
            editFormFactory(
                f,
                inIframe
            )
        );
    }

    let theForm =
        document.querySelector(
            'form.edit-work'
        );

    if (
        theForm &&
        !theForm
        .ROpdebee_Work_Codes_Found
    ) {
        editFormFactory(
            theForm,
            false
        );
    }

    let observer =
        new MutationObserver(
            handleChange
        );

    observer.observe(
        document,
        {
            subtree: true,
            childList: true
        }
    );
}


//////////////
// Repertoires
//////////////

const iswcRegex =
      /\bT-\d{3}\.\d{3}\.\d{3}-\d\b/;


function formatCompactISWC(raw) {
    if (!raw) {
        return null;
    }

    const value =
          raw
    .trim()
    .toUpperCase();

    const compactMatch =
          value.match(
              /^T(\d{3})(\d{3})(\d{3})(\d)$/
          );

    if (compactMatch) {
        return (
            `T-${compactMatch[1]}.` +
            `${compactMatch[2]}.` +
            `${compactMatch[3]}-` +
            `${compactMatch[4]}`
        );
    }

    if (
        /^T-\d{3}\.\d{3}\.\d{3}-\d$/
        .test(value)
    ) {
        return value;
    }

    return null;
}


function makeASCAPSourceUrl(workID) {
    if (!workID) {
        return null;
    }

    return (
        'https://www.ascap.com/repertory' +
        '#/ace/search/workID/' +
        encodeURIComponent(workID)
    );
}


function makeBMISourceUrl(workID) {
    if (!workID) {
        return null;
    }

    return (
        'https://repertoire.bmi.com/Search/Search?' +
        'SearchForm.Main_Search=BMI+Work+ID&' +
        'SearchForm.Main_Search_Text=' +
        encodeURIComponent(workID)
    );
}

function storeData(
source,
 iswcs,
 codes,
 title,
 sourceUrl = null,
 sourceReference = null
) {
    let obj = {
        source: source,
        sourceUrl: sourceUrl,
        sourceReference: sourceReference,
        iswcs: iswcs,
        agencyCodes: codes,
        title: title,
    };

    console.log(obj);

    GM_setValue(
        'workCodeData',
        JSON.stringify(obj)
    );
}


//////////////
// ISWCNet
//////////////

let translateStrings =
    (function() {
        let strings;

        const stringsDefaults = {
            AGENCY_NAME_FIELD:
            'Agency Name',

            AGENCY_WORK_CODES:
            'Agency Work Codes',

            AGENCY_WORK_CODE_FIELD:
            'Agency Work Code',

            ARCHIVED_ISWCS:
            'Archived ISWCs',

            ORIGINAL_TITLE_FIELD:
            'Original Title',

            ISWC_FIELD:
            'ISWC',
        };

        return function(text) {
            if (!strings) {
                const stringsJson =
                      localStorage.getItem(
                          'strings'
                      );

                if (
                    !stringsJson
                ) {
                    console.error(
                        'Could not extract translations!'
                    );

                    return stringsDefaults[
                        text
                    ];
                }

                strings =
                    JSON.parse(
                    stringsJson
                );
            }

            return (
                strings[text] ||
                stringsDefaults[text]
            );
        };
    })();


function handleISWCNet() {
    function findAgencyWorkCodes(
    table
    ) {
        let codeTable =
            findDivByText(
                table,
                `${translateStrings('AGENCY_WORK_CODES')}:`
            ).map(
                div => div.nextSibling
            );

        if (
            !codeTable.length
        ) {
            return {};
        }

        let rows = [
            ...codeTable[0]
            .querySelectorAll(
                'tbody > tr'
            )
        ];

        let groupedCodes =
            rows.groupBy(
                row =>
                row.querySelector(
                    `td[id="${translateStrings('AGENCY_NAME_FIELD')}:"]`
                ).innerText,

                row =>
                row.querySelector(
                    `td[id="${translateStrings('AGENCY_WORK_CODE_FIELD')}:"]`
                ).innerText
            );

        if (
            'CASH' in groupedCodes
        ) {
            groupedCodes[
                'CASH'
            ] =
                groupedCodes[
                'CASH'
            ].map(
                code =>
                `C-${code}`
            );
        }

        return groupedCodes;
    }

    function findIswcs(table) {
        const iswcs =
              [];

        const currentISWC =
              table.querySelector(
                  `td[id="${translateStrings('ISWC_FIELD')}:"]`
              );

        if (currentISWC) {
            const matches =
                  currentISWC
            .textContent
            .match(
                /\bT-\d{3}\.\d{3}\.\d{3}-\d\b/g
            ) || [];

            iswcs.push(
                ...matches
            );
        }

        findDivByText(
            table,
            translateStrings(
                'ARCHIVED_ISWCS'
            )
        ).forEach(
            archivedTitle => {
                const archivedISWCsDiv =
                      archivedTitle
                .nextSibling;

                if (
                    !archivedISWCsDiv
                ) {
                    return;
                }

                const matches =
                      archivedISWCsDiv
                .textContent
                .match(
                    /\bT-\d{3}\.\d{3}\.\d{3}-\d\b/g
                ) || [];

                iswcs.push(
                    ...matches
                );
            }
        );

        return [
            ...new Set(iswcs)
        ];
    }

    function findTitle(table) {
        return table
            .querySelector(
            `td[id="${translateStrings('ORIGINAL_TITLE_FIELD')}:"]`
        )
            .innerText;
    }

    function parseAndCopy(
    table
    ) {
        let workCodes =
            findAgencyWorkCodes(
                table
            );

        let iswcs =
            findIswcs(
                table
            );

        let title =
            findTitle(
                table
            );

        const firstISWC =
              iswcs.length
        ? iswcs[0]
        : null;

        storeData(
            'CISAC ISWCNet',
            iswcs,
            workCodes,
            title,
            'https://iswcnet.cisac.org/',
            firstISWC
            ? `Search ISWC: ${firstISWC}`
            : null
        );
    }

    function handleChangeCisac(
    mutationRec
    ) {
        if (
            mutationRec.length === 0 ||
            mutationRec[0]
            .addedNodes
            .length === 0
        ) {
            return;
        }

        if (
            mutationRec[0]
            .addedNodes[0]
            .nodeName !== 'TR'
        ) {
            return;
        }

        let viewMoreDiv =
            mutationRec[0]
        .addedNodes[0]
        .querySelector(
            "[class^='ViewMore_viewMoreContainer']"
        );

        if (!viewMoreDiv) {
            return;
        }

        let entry =
            viewMoreDiv
        .parentNode
        .parentNode
        .parentNode;

        let button =
            document.createElement(
                'button'
            );

        button.innerText =
            'Copy work codes';

        button.onclick =
            () =>
        parseAndCopy(
            entry
        );

        viewMoreDiv.prepend(
            button
        );
    }

    let observer =
        new MutationObserver(
            handleChangeCisac
        );

    observer.observe(
        document,
        {
            subtree: true,
            childList: true
        }
    );
}


//////////////
// BMI Songview
//////////////

function handleSongview() {
    function findTitle(result) {
        return (
            result
            .querySelector(
                '.song-title'
            )
            ?.textContent
            .trim()
            || ''
        );
    }

    function findIswcs(result) {
        const details =
              result.querySelector(
                  '.details-slide'
              );

        if (!details) {
            return [];
        }

        const matches =
              details
        .textContent
        .match(
            /\bT(?:-?\d{3}\.?\d{3}\.?\d{3}-?\d)\b/gi
        ) || [];

        return [
            ...new Set(
                matches
                .map(
                    formatCompactISWC
                )
                .filter(Boolean)
            )
        ];
    }

    function findAgencyWorkCodes(
    result
    ) {
        const details =
              result.querySelector(
                  '.details-slide'
              );

        if (!details) {
            return {};
        }

        const codes =
              {};

        const leftBlock =
              details.querySelector(
                  '.details-content-block-01'
              );

        if (!leftBlock) {
            return codes;
        }

        const tables = [
            ...leftBlock.querySelectorAll(
                ':scope > ul > table'
            )
        ];

        const societyTable =
              tables.find(
                  table =>
                  [
                      ...table.querySelectorAll(
                          'tr.soc-hdr-row th, ' +
                          'tr.soc-hdr-row td, ' +
                          'tr.soc-hdr-row strong'
                      )
                  ].some(
                      el =>
                      el.textContent
                      .trim() ===
                      'Work ID'
                  )
              );

        if (!societyTable) {
            return codes;
        }

        societyTable
            .querySelectorAll(
            'tr.soc-details-row'
        )
            .forEach(
            row => {
                const cells = [
                    ...row.querySelectorAll(
                        ':scope > td'
                    )
                ];

                if (
                    cells.length < 4
                ) {
                    return;
                }

                const agency =
                      cells[0]
                .textContent
                .trim();

                const workID =
                      cells[3]
                .textContent
                .trim();

                if (
                    !agency ||
                    !workID ||
                    agency.toLowerCase() ===
                    'other'
                ) {
                    return;
                }

                if (
                    !codes[agency]
                ) {
                    codes[agency] =
                        [];
                }

                if (
                    !codes[agency]
                    .includes(
                        workID
                    )
                ) {
                    codes[
                        agency
                    ].push(
                        workID
                    );
                }
            }
        );

        return codes;
    }

    function parseAndCopy(
    result
    ) {
        const workCodes =
              findAgencyWorkCodes(
                  result
              );

        const iswcs =
              findIswcs(
                  result
              );

        const title =
              findTitle(
                  result
              );

        const bmiWorkID =
              workCodes['BMI']?.[0] ||
              null;

        storeData(
            'BMI Songview',
            iswcs,
            workCodes,
            title,
            makeBMISourceUrl(
                bmiWorkID
            ),
            null
        );
    }

    function injectButtons(
    parentNode = document
    ) {
        const results =
              parentNode.matches?.(
                  '.result-list > ul > li'
              )
        ? [parentNode]
        : [
            ...(
                parentNode
                .querySelectorAll?.(
                    '.result-list > ul > li'
                ) || []
            )
        ];

        results.forEach(
            result => {
                if (
                    result.dataset
                    .ropdebeeWorkCodesFound
                ) {
                    return;
                }

                const buttonList =
                      result.querySelector(
                          '.buttons-block > ul'
                      );

                if (!buttonList) {
                    return;
                }

                result.dataset
                    .ropdebeeWorkCodesFound =
                    'true';

                const li =
                      document.createElement(
                          'li'
                      );

                const button =
                      document.createElement(
                          'a'
                      );

                button.href =
                    '#';

                button.className =
                    'ropdebee-copy-work-codes';

                button.textContent =
                    'Copy work codes';

                button.title =
                    "Copy this work's ISWC and society work IDs for MusicBrainz.";

                button.addEventListener(
                    'click',
                    event => {
                        event.preventDefault();
                        event.stopPropagation();

                        parseAndCopy(
                            result
                        );

                        const oldText =
                              button.textContent;

                        button.textContent =
                            'Copied!';

                        window.setTimeout(
                            () => {
                                button.textContent =
                                    oldText;
                            },
                            1200
                        );
                    }
                );

                li.appendChild(
                    button
                );

                buttonList.appendChild(
                    li
                );
            }
        );
    }

    injectButtons();

    const observer =
          new MutationObserver(
              mutationRecords => {
                  mutationRecords.forEach(
                      record => {
                          record
                              .addedNodes
                              .forEach(
                              node => {
                                  if (
                                      node.nodeType !==
                                      Node.ELEMENT_NODE
                                  ) {
                                      return;
                                  }

                                  injectButtons(
                                      node
                                  );
                              }
                          );
                      }
                  );
              }
          );

    observer.observe(
        document.body,
        {
            subtree: true,
            childList: true,
        }
    );
}


//////////////
// ASCAP Repertory / Songview
//////////////

function handleASCAP() {
    function findTitle(card) {
        return (
            card
            .querySelector(
                '.workcard__header h2'
            )
            ?.textContent
            .trim()
            || ''
        );
    }

    function findHeaderInfoValue(
    card,
     label
    ) {
        const infoItems = [
            ...card.querySelectorAll(
                '.workcard__header .info-list > li'
            )
        ];

        for (
            const item of infoItems
        ) {
            const text =
                  item.textContent
            .replace(/\s+/g, ' ')
            .trim();

            if (
                !text.toLowerCase()
                .startsWith(
                    label.toLowerCase() +
                    ':'
                )
            ) {
                continue;
            }

            const span =
                  item.querySelector(
                      'span'
                  );

            if (span) {
                return span
                    .textContent
                    .trim();
            }

            return text
                .slice(
                label.length + 1
            )
                .trim();
        }

        return null;
    }

    function findIswcs(card) {
        const rawISWC =
              findHeaderInfoValue(
                  card,
                  'ISWC'
              );

        const formatted =
              formatCompactISWC(
                  rawISWC
              );

        return formatted
            ? [formatted]
        : [];
    }

    function findAgencyWorkCodes(
    card
    ) {
        const workID =
              findHeaderInfoValue(
                  card,
                  'Work ID'
              );

        if (!workID) {
            return {};
        }

        return {
            'ASCAP': [
                workID
            ]
        };
    }

    function parseAndCopy(
    card
    ) {
        const title =
              findTitle(
                  card
              );

        const iswcs =
              findIswcs(
                  card
              );

        const workCodes =
              findAgencyWorkCodes(
                  card
              );

        const ascapWorkID =
              workCodes['ASCAP']?.[0] ||
              null;

        storeData(
            'ASCAP Repertory',
            iswcs,
            workCodes,
            title,
            makeASCAPSourceUrl(
                ascapWorkID
            ),
            null
        );
    }

    function makeButton(card) {
        const wrapper =
              document.createElement(
                  'div'
              );

        wrapper.className =
            'col-auto ropdebee-copy-work-codes-wrapper';

        const button =
              document.createElement(
                  'button'
              );

        button.type =
            'button';

        button.className =
            'c-btn c-btn--secondary';

        button.textContent =
            'Copy work codes';

        button.title =
            'Copy ASCAP Work ID and ISWC for MusicBrainz';

        button.addEventListener(
            'click',
            event => {
                event.preventDefault();
                event.stopPropagation();

                parseAndCopy(
                    card
                );

                const oldText =
                      button.textContent;

                button.textContent =
                    'Copied!';

                window.setTimeout(
                    () => {
                        button.textContent =
                            oldText;
                    },
                    1200
                );
            }
        );

        wrapper.appendChild(
            button
        );

        return wrapper;
    }

    function findButtonRow(card) {
        const rows = [
            ...card.querySelectorAll(
                '.c-card__body > .row'
            )
        ];

        return rows.find(
            row =>
            row.classList.contains(
                'do-not-print'
            ) &&
            row.classList.contains(
                'h-justify-content-flex-end'
            )
        ) || null;
    }

    function injectButton(card) {
        if (
            card.dataset
            .ropdebeeWorkCodesFound
        ) {
            return;
        }

        const buttonRow =
              findButtonRow(
                  card
              );

        if (!buttonRow) {
            return;
        }

        card.dataset
            .ropdebeeWorkCodesFound =
            'true';

        buttonRow.prepend(
            makeButton(
                card
            )
        );
    }

    function injectButtons(
    parentNode = document
    ) {
        let cards =
            [];

        if (
            parentNode.matches?.(
                'article.c-card.songview'
            )
        ) {
            cards.push(
                parentNode
            );
        }

        cards.push(
            ...(
                parentNode
                .querySelectorAll?.(
                    'article.c-card.songview'
                ) || []
            )
        );

        cards.forEach(
            injectButton
        );
    }

    injectButtons();

    const observer =
          new MutationObserver(
              records => {
                  for (
                      const record of records
                  ) {
                      if (
                          record.target
                          .nodeType ===
                          Node.ELEMENT_NODE
                      ) {
                          const existingCard =
                                record.target
                          .closest?.(
                              'article.c-card.songview'
                          );

                          if (existingCard) {
                              injectButton(
                                  existingCard
                              );
                          }
                      }

                      for (
                          const node of
                          record.addedNodes
                      ) {
                          if (
                              node.nodeType !==
                              Node.ELEMENT_NODE
                          ) {
                              continue;
                          }

                          injectButtons(
                              node
                          );

                          const containingCard =
                                node.closest?.(
                                    'article.c-card.songview'
                                );

                          if (
                              containingCard
                          ) {
                              injectButton(
                                  containingCard
                              );
                          }
                      }
                  }
              }
          );

    observer.observe(
        document.body,
        {
            subtree: true,
            childList: true,
        }
    );
}


//////////////
// GEMA
//////////////

function handleGEMA() {
    function findAgencyWorkCodes(
    tr
    ) {
        return {
            'GEMA': [
                tr.querySelector(
                    '.workSocworkcde'
                )
                .innerText
                .match(
                    /(\d{0,8})[\-‐](\d{3})/
                )[0],
            ],
        };
    }

    function findIswcs(tr) {
        return [
            tr.querySelector(
                '.workIswc'
            )
            .innerText
            .match(
                iswcRegex
            )[0],
        ];
    }

    function findTitle(tr) {
        return tr
            .querySelector(
            '.workSearchedTitle'
        )
            .innerText;
    }

    function parseAndCopy(
    tr
    ) {
        let workCodes =
            findAgencyWorkCodes(
                tr
            );

        let iswcs =
            findIswcs(
                tr
            );

        let title =
            findTitle(
                tr
            );

        storeData(
            'GEMA Repertoire Search',
            iswcs,
            workCodes,
            title,
            document.location.href,
            null
        );
    }

    function injectButtons(
    parentNode = document
    ) {
        parentNode
            .querySelectorAll(
            '[id="auswahlForm:searchResultItems:tb"] > tr'
        )
            .forEach(
            tr => {
                let button =
                    document.createElement(
                        'button'
                    );

                button.innerText =
                    'Copy work codes';

                button.addEventListener(
                    'click',
                    event => {
                        event.preventDefault();

                        parseAndCopy(
                            tr
                        );
                    }
                );

                tr.querySelector(
                    '.empty'
                )
                    .prepend(
                    button
                );
            }
        );
    }

    function handleChangeGEMA(
    mutationRec
    ) {
        if (
            mutationRec.length === 0 ||
            mutationRec[0]
            .addedNodes
            .length === 0
        ) {
            return;
        }

        const searchResults =
              mutationRec[0]
        .addedNodes[0];

        if (
            searchResults.nodeType !==
            Node.ELEMENT_NODE
        ) {
            return;
        }

        injectButtons(
            searchResults
        );
    }

    if (
        Object.toJSON
    ) {
        JSON.stringify =
            Object.toJSON;
    }

    const observer =
          new MutationObserver(
              handleChangeGEMA
          );

    observer.observe(
        document.querySelector(
            'div.body'
        ),
        {
            childList: true,
        }
    );

    injectButtons();
}


//////////////
// Site dispatch
//////////////

const repertoireToHandler = {
    'iswcnet.cisac.org':
    handleISWCNet,

    'online.gema.de':
    handleGEMA,

    'repertoire.bmi.com':
    handleSongview,

    'www.ascap.com':
    handleASCAP,

    'ascap.com':
    handleASCAP,
};


if (
    document.location.hostname ===
    'musicbrainz.org' ||
    document.location.hostname.endsWith(
        '.musicbrainz.org'
    )
) {
    handleMB();
} else {
    const handler =
          repertoireToHandler[
              document.location.hostname
          ];

    if (handler) {
        handler();
    }
}
