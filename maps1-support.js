// maps1-support.js — the Contact Support dialog (guided billing flow, entitlement
// re-check, in-app access refresh, payment-screenshot attachment).
//
// LAZY-LOADED: maps1-app.js injects this script the first time a support entry point
// is tapped, so ~700 lines of dialog logic and ~20 event listeners cost nothing on a
// normal session — the overwhelming majority of visitors never open support.
//
// By the time this executes the host globals all exist: maps1-app.js is a classic
// top-level script, so its let/const/function names share this script's global
// scope. This module reads currentUser, map, menuData, activePurchases,
// pendingSupportOpen, functions, and calls hasPurchase / findPurchaseEntry /
// findDistrictAtCenter / findDistrictByPurchaseId / fetchPurchaseStatus /
// syncEdgeToEntitlements / checkAndReenableMap / showZoomRestrictionDialog /
// enableMapInteraction — all defined over there. Same bridge maps-annotations.js uses.
//
// The dialog MARKUP lives in maps1.html (static, inert until opened); only the
// behaviour is deferred.
//
// Sole entry point: window.mmSupport.open(district, returnToPaywall).
(function () {
    'use strict';
    if (window.mmSupport) return;

    // ---- markup ----------------------------------------------------------
    // The dialog's contents live here, not in maps1.html, so the initial page
    // payload does not carry ~11 KB of markup for a dialog most sessions never
    // open. The overlay SHELL (#support-dialog-overlay, with its data-dismiss
    // attribute) stays in the HTML because the back-button observer binds to it
    // at DOMContentLoaded and cannot see an element injected later.
    var _host = document.getElementById('support-dialog-body');
    if (!_host) return;
    _host.innerHTML = `            <!-- Step 1: choose problem type -->
            <div id="support-choice-section" style="display:none;">
                <h3 style="text-align:center;margin-bottom:8px;">How can we help?</h3>
                <p style="font-size:13px;color:#5f6368;text-align:center;margin:0 0 20px 0;">Pick the type of problem so we can route it correctly.</p>
                <button class="auth-dialog-btn" id="support-choice-billing" style="width:100%;justify-content:flex-start;text-align:left;margin-bottom:12px;">
                    <span style="display:block;">
                        <span style="display:block;font-weight:600;color:#202124;">Billing Problem</span>
                        <span style="display:block;font-size:12px;color:#5f6368;">I paid for a region but it's not working</span>
                    </span>
                </button>
                <button class="auth-dialog-btn" id="support-choice-other" style="width:100%;justify-content:flex-start;text-align:left;margin-bottom:0;">
                    <span style="display:block;">
                        <span style="display:block;font-weight:600;color:#202124;">Other Problem</span>
                        <span style="display:block;font-size:12px;color:#5f6368;">Something else — bug, feedback, general help</span>
                    </span>
                </button>
                <button class="auth-dialog-cancel" id="support-choice-cancel">Cancel</button>
            </div>
            <!-- Step 2 (Billing): pick the region you paid for -->
            <div id="support-billing-section" style="display:none;">
                <h3 style="text-align:center;margin-bottom:8px;">Which region did you pay for?</h3>
                <p style="font-size:13px;color:#5f6368;text-align:center;margin:0 0 14px 0;">Search and select the region your pass should unlock.</p>
                <input type="text" id="support-region-search" placeholder="Search region…" autocomplete="off" style="width:100%;padding:8px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;color:#333;margin-bottom:10px;box-sizing:border-box;">
                <div id="support-region-list" style="max-height:230px;overflow-y:auto;border:1px solid #eee;border-radius:8px;margin-bottom:14px;"></div>
                <button class="auth-dialog-btn" id="support-billing-next" style="width:100%;justify-content:center;margin-bottom:0;" disabled>Next</button>
                <button class="auth-dialog-cancel" id="support-billing-back">Back</button>
            </div>
            <!-- Step 3 (Billing): confused-region guard -->
            <div id="support-confusion-section" style="display:none;">
                <h3 style="text-align:center;margin-bottom:12px;color:#e65100;">Are these the same region?</h3>
                <div style="background:#fff8e1;padding:12px;border-radius:8px;border-left:3px solid #f9a825;margin:0 0 16px 0;font-size:13px;line-height:1.5;color:#5d4037;">
                    <span id="support-confusion-text">&nbsp;</span>
                </div>
                <button class="auth-dialog-btn" id="support-confusion-confirm" style="width:100%;justify-content:center;margin-bottom:0;">Yes, contact support</button>
                <button class="auth-dialog-cancel" id="support-confusion-back">No, take me back</button>
            </div>
            <!-- Step 3b (Billing): the pass IS live -> offer the real fix before support -->
            <div id="support-fix-section" style="display:none;">
                <h3 style="text-align:center;margin-bottom:12px;color:#2E7D32;">Your pass is active</h3>
                <div style="background:#e8f5e9;padding:12px;border-radius:8px;border-left:3px solid #2E7D32;margin:0 0 14px 0;font-size:13px;line-height:1.5;color:#1b5e20;">
                    <span id="support-fix-text">&nbsp;</span>
                </div>
                <button class="auth-dialog-btn" id="support-fix-refresh" style="width:100%;justify-content:center;margin-bottom:10px;">Refresh my access now</button>
                <button class="auth-dialog-btn" id="support-fix-reload" style="width:100%;justify-content:center;margin-bottom:10px;background:#fff;color:#1a73e8;border:1px solid #dadce0;">Reload the page</button>
                <div id="support-fix-result" style="display:none;background:#fff8e1;padding:10px 12px;border-radius:8px;border-left:3px solid #f9a825;margin:0 0 12px 0;font-size:13px;line-height:1.5;color:#5d4037;"></div>
                <button class="auth-dialog-cancel" id="support-fix-proceed" style="display:none;">Still not working &mdash; contact support</button>
                <button class="auth-dialog-cancel" id="support-fix-back">Back</button>
            </div>
            <!-- Step 3c (Billing): no purchase on record -> ask for payment proof -->
            <div id="support-proof-section" style="display:none;">
                <h3 style="text-align:center;margin-bottom:12px;color:#e65100;">No purchase found</h3>
                <div style="background:#fff8e1;padding:12px;border-radius:8px;border-left:3px solid #f9a825;margin:0 0 14px 0;font-size:13px;line-height:1.5;color:#5d4037;">
                    We could not find any web purchase for <strong id="support-proof-region">&nbsp;</strong> on <strong id="support-proof-email" style="word-break:break-all;">&nbsp;</strong>.
                </div>
                <div style="background:#fff8e1;padding:10px 12px;border-radius:8px;border-left:3px solid #f9a825;margin:0 0 14px 0;font-size:12.5px;line-height:1.45;color:#5d4037;">
                    <strong>Note:</strong> Android &amp; Web are <strong>separate platforms</strong> &mdash; a subscription bought on the Android app does <strong>not</strong> work on web (and vice versa).
                </div>
                <p style="font-size:13px;line-height:1.5;color:#333;margin:0 0 12px 0;">If you did pay for this region on the website, please attach a screenshot of your payment receipt (Razorpay confirmation, bank/UPI message, or card statement) so we can trace it quickly.</p>
                <input type="file" id="support-proof-file" accept="image/*" style="display:none;">
                <button class="auth-dialog-btn" id="support-proof-pick" style="width:100%;justify-content:center;margin-bottom:10px;background:#fff;color:#1a73e8;border:1px solid #dadce0;">Attach payment screenshot</button>
                <div id="support-proof-preview" style="display:none;align-items:center;gap:10px;background:#f5f5f5;border-radius:8px;padding:8px 10px;margin-bottom:10px;">
                    <img id="support-proof-thumb" alt="Attached screenshot" style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid #ddd;flex:none;">
                    <span id="support-proof-meta" style="font-size:12px;color:#5f6368;flex:1;line-height:1.4;"></span>
                    <button type="button" id="support-proof-remove" style="background:none;border:none;color:#c62828;font-size:12px;cursor:pointer;padding:4px;flex:none;">Remove</button>
                </div>
                <div id="support-proof-error" style="display:none;font-size:12.5px;line-height:1.45;color:#c62828;margin:0 0 10px 0;"></div>
                <button class="auth-dialog-btn" id="support-proof-next" style="width:100%;justify-content:center;margin-bottom:0;" disabled>Continue</button>
                <button type="button" id="support-proof-skip" style="display:block;width:100%;background:none;border:none;color:#5f6368;font-size:12.5px;text-decoration:underline;cursor:pointer;padding:10px 0 0 0;">I can't attach a screenshot</button>
                <button class="auth-dialog-cancel" id="support-proof-back">Back</button>
            </div>
            <div id="support-form-section">
                <h3 style="text-align:center;margin-bottom:16px;">Contact Support</h3>
                <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">To</label>
                <input type="text" value="support@mapmagician.in" readonly style="width:100%;padding:8px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;color:#333;background:#f5f5f5;margin-bottom:12px;box-sizing:border-box;">
                <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Your Email</label>
                <input type="text" id="support-email" readonly style="width:100%;padding:8px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;color:#333;background:#f5f5f5;margin-bottom:12px;box-sizing:border-box;">
                <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Region</label>
                <input type="text" id="support-region" readonly style="width:100%;padding:8px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;color:#333;background:#f5f5f5;margin-bottom:12px;box-sizing:border-box;">
                <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Your Message</label>
                <textarea id="support-message" rows="4" placeholder="Describe your issue..." style="width:100%;padding:8px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;resize:vertical;margin-bottom:16px;box-sizing:border-box;font-family:inherit;"></textarea>
                <div style="background:#fff8e1;padding:10px 12px;border-radius:8px;border-left:3px solid #f9a825;margin:0 0 14px 0;font-size:12.5px;line-height:1.45;color:#5d4037;">
                    <strong>Note:</strong> Android &amp; Web are <strong>separate platforms</strong> &mdash; a subscription bought on the Android app does <strong>not</strong> work on web (and vice versa).
                </div>
                <button class="auth-dialog-btn" id="support-send-btn" style="width:100%;justify-content:center;margin-bottom:0;">Send Message</button>
                <button class="auth-dialog-cancel" id="support-cancel-btn">Cancel</button>
            </div>
            <div id="support-success-section" style="display:none;">
                <h3 style="text-align:center;margin-bottom:16px;color:#2E7D32;">Message Sent</h3>
                <p style="font-size:14px;line-height:1.5;color:#333;margin:0 0 12px 0;">Thank you for contacting MapMagician. We have received your request and typically reply within <strong>24 hours</strong>.</p>
                <p style="font-size:14px;line-height:1.5;color:#333;margin:0 0 12px 0;">Our reply will be sent to your registered login email:</p>
                <div style="background:#e8f5e9;padding:10px 12px;border-radius:8px;border-left:3px solid #2E7D32;margin:0 0 12px 0;font-size:13px;color:#1b5e20;word-break:break-all;">
                    <strong id="support-success-email">&nbsp;</strong>
                </div>
                <div style="background:#fff8e1;padding:12px;border-radius:8px;border-left:3px solid #f9a825;margin:12px 0;font-size:13px;line-height:1.5;color:#5d4037;">
                    <strong>Please also check your Junk / Spam folder</strong> if you do not see our reply in your inbox within 24 hours.
                </div>
                <button type="button" class="auth-dialog-btn" id="support-success-close-btn" style="width:100%;justify-content:center;margin-bottom:0;">Close</button>
            </div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid #eee;text-align:center;font-size:11px;color:#888;letter-spacing:0.3px;">
                Powered by <span style="color:#00796B;font-weight:600;">MapMagician</span>
            </div>`;
        // --- Support form ---
        let supportReturnToPaywall = false;
        let supportPaywallDistrict = null;

        // Guided support flow state
        let supportFlowMode = 'other';            // 'billing' | 'other'
        let supportBillingSelection = null;       // { pid, name } region the user claims to have paid for
        let supportBillingNoRecord = false;       // true when no purchase record matched the selected region
        let supportBillingRecordNote = '';        // human-readable record-check summary for the email
        let supportConfusionOwnedName = '';       // confused-partner region the user actually owns
        let supportConfusionOwnedPid = '';
        let supportRefreshAttempted = false;      // the in-app access refresh was run and did not help
        let supportProofB64 = '';                 // payment screenshot, base64 JPEG (no data: prefix)
        let supportProofName = '';
        let supportProofBytes = 0;
        let supportProofUrl = '';                 // object URL behind the thumbnail; must be revoked
        let supportProofDeclined = false;         // user said they cannot attach a screenshot

        // Regions that users routinely confuse with each other: distinct regions within the
        // same area where a pass for one does NOT unlock the other. Extend as more surface.
        const REGION_CONFUSION_GROUPS = [
            { area: 'Pune District', members: ['punedpplan', 'pmrda_plan'] },
        ];

        function supportEsc(s) {
            const d = document.createElement('div');
            d.textContent = (s == null) ? '' : String(s);
            return d.innerHTML;
        }

        function normPid(pid) {
            return String(pid || '').toLowerCase().replace(/gst$/, '');
        }

        // Given a productPurchaseID, return { partners, area } from any confusion group it belongs to.
        function confusionPartners(pid) {
            const n = normPid(pid);
            const out = [];
            let area = '';
            REGION_CONFUSION_GROUPS.forEach(function (group) {
                const norm = group.members.map(normPid);
                if (norm.indexOf(n) !== -1) {
                    area = group.area || '';
                    group.members.forEach(function (g, i) { if (norm[i] !== n) out.push(g); });
                }
            });
            return { partners: out, area: area };
        }

        // User is viewing `accessedPid` (a region they do NOT own). If they own a
        // confused-partner region (e.g. own Pune while zooming into PMRDA), return
        // that owned partner's display info so we can surface the clearance dialog.
        // Returns null when no owned partner applies.
        function ownedConfusionPartner(accessedPid) {
            if (!accessedPid || hasPurchase(accessedPid)) return null;
            const conf = confusionPartners(accessedPid);
            for (let i = 0; i < conf.partners.length; i++) {
                if (hasPurchase(conf.partners[i])) {
                    const pm = findDistrictByPurchaseId(conf.partners[i]);
                    return {
                        ownedPid:  conf.partners[i],
                        ownedName: pm ? pm.districtName : conf.partners[i],
                        area:      conf.area || ''
                    };
                }
            }
            return null;
        }

        // Show exactly one step of the support dialog; hide the rest.
        function supportShowSection(id) {
            ['support-choice-section', 'support-billing-section', 'support-confusion-section',
                'support-fix-section', 'support-proof-section',
                'support-form-section', 'support-success-section'].forEach(function (s) {
                const el = document.getElementById(s);
                if (el) el.style.display = (s === id) ? '' : 'none';
            });
        }

        // Deduped, name-sorted list of purchasable regions derived from menuData.
        function getSupportRegionOptions() {
            const seen = {};
            const out = [];
            (menuData || []).forEach(function (item) {
                const pid = item.productPurchaseID;
                if (!pid) return;
                const key = pid.toLowerCase();
                if (seen[key]) return;
                seen[key] = true;
                out.push({ pid: pid, name: item.district || item.state || pid });
            });
            out.sort(function (a, b) { return a.name.localeCompare(b.name); });
            return out;
        }

        function renderSupportRegionList(filter) {
            const listEl = document.getElementById('support-region-list');
            if (!listEl) return;
            let opts = getSupportRegionOptions();
            const f = (filter || '').trim().toLowerCase();
            if (f) opts = opts.filter(function (o) { return o.name.toLowerCase().indexOf(f) !== -1; });
            listEl.innerHTML = '';
            if (opts.length === 0) {
                listEl.innerHTML = '<div style="padding:12px;font-size:13px;color:#888;text-align:center;">No matching region</div>';
                return;
            }
            opts.forEach(function (o) {
                const row = document.createElement('div');
                row.textContent = o.name;
                row.style.cssText = 'padding:9px 12px;font-size:13px;color:#333;cursor:pointer;border-bottom:1px solid #f2f2f2;';
                if (supportBillingSelection && supportBillingSelection.pid === o.pid) {
                    row.style.background = '#e8f0fe';
                    row.style.fontWeight = '600';
                }
                row.addEventListener('click', function () {
                    supportBillingSelection = { pid: o.pid, name: o.name };
                    document.getElementById('support-billing-next').disabled = false;
                    renderSupportRegionList(document.getElementById('support-region-search').value);
                });
                listEl.appendChild(row);
            });
        }

        function resetSupportFlow() {
            supportFlowMode = 'other';
            supportBillingSelection = null;
            supportBillingNoRecord = false;
            supportBillingRecordNote = '';
            supportConfusionOwnedName = '';
            supportConfusionOwnedPid = '';
            supportRefreshAttempted = false;
            if (_supportFixValveTimer) { clearTimeout(_supportFixValveTimer); _supportFixValveTimer = null; }
            clearSupportProof();
            const search = document.getElementById('support-region-search');
            if (search) search.value = '';
            const nextBtn = document.getElementById('support-billing-next');
            if (nextBtn) nextBtn.disabled = true;
        }

        // Drop any attached screenshot and its preview. Called on reset AND on close, so a
        // screenshot can never ride along into an unrelated later request, and the object URL
        // never outlives the dialog.
        function clearSupportProof() {
            if (supportProofUrl) { try { URL.revokeObjectURL(supportProofUrl); } catch (e) {} }
            supportProofB64 = '';
            supportProofName = '';
            supportProofBytes = 0;
            supportProofUrl = '';
            supportProofDeclined = false;
            const fileEl = document.getElementById('support-proof-file');
            if (fileEl) fileEl.value = '';
            const prev = document.getElementById('support-proof-preview');
            if (prev) prev.style.display = 'none';
            const thumb = document.getElementById('support-proof-thumb');
            if (thumb) thumb.removeAttribute('src');
            const err = document.getElementById('support-proof-error');
            if (err) { err.style.display = 'none'; err.textContent = ''; }
            const nextEl = document.getElementById('support-proof-next');
            if (nextEl) nextEl.disabled = true;
        }

        // Downscale + JPEG-compress a chosen screenshot entirely in the browser, so the bytes
        // that reach the backend are small enough to ride out as a mail attachment. Nothing is
        // uploaded to storage — see sendSupportRequest. Mirrors the toBlob('image/jpeg', q)
        // pattern already used by the Download Map finalize step.
        const SUPPORT_IMG_MAX_EDGE = 1600;
        const SUPPORT_IMG_MAX_BYTES = 700 * 1024;
        function supportPrepareScreenshot(file) {
            return new Promise(function (resolve, reject) {
                if (!file) { reject(new Error('No file was selected.')); return; }
                if (!/^image\//.test(file.type || '')) {
                    reject(new Error('Please choose an image file (JPG or PNG).')); return;
                }
                if (file.size > 15 * 1024 * 1024) {
                    reject(new Error('That image is over 15 MB. Please choose a smaller one.')); return;
                }
                const fr = new FileReader();
                fr.onerror = function () { reject(new Error('Could not read that file.')); };
                fr.onload = function () {
                    const img = new Image();
                    img.onerror = function () { reject(new Error('That file is not a readable image.')); };
                    img.onload = function () {
                        const scale = Math.min(1, SUPPORT_IMG_MAX_EDGE / Math.max(img.width, img.height));
                        const c = document.createElement('canvas');
                        c.width = Math.max(1, Math.round(img.width * scale));
                        c.height = Math.max(1, Math.round(img.height * scale));
                        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                        const qualities = [0.8, 0.65, 0.5, 0.38];
                        (function step(qi) {
                            if (qi >= qualities.length) {
                                reject(new Error('Could not compress that screenshot small enough. Please crop it to just the receipt and try again.'));
                                return;
                            }
                            c.toBlob(function (blob) {
                                if (!blob) { reject(new Error('Could not process that image.')); return; }
                                if (blob.size > SUPPORT_IMG_MAX_BYTES) { step(qi + 1); return; }
                                const fr2 = new FileReader();
                                fr2.onerror = function () { reject(new Error('Could not encode that image.')); };
                                fr2.onload = function () {
                                    resolve({
                                        b64: String(fr2.result).split(',')[1] || '',
                                        bytes: blob.size,
                                        url: URL.createObjectURL(blob)
                                    });
                                };
                                fr2.readAsDataURL(blob);
                            }, 'image/jpeg', qualities[qi]);
                        })(0);
                    };
                    img.src = fr.result;
                };
                fr.readAsDataURL(file);
            });
        }

        // Enter the final free-text form step with region + an optional pre-filled message.
        function showSupportFormStep(regionName, prefillMessage) {
            document.getElementById('support-region').value = regionName || (findDistrictAtCenter()?.districtName || 'General');
            document.getElementById('support-message').value = prefillMessage || '';
            document.getElementById('support-send-btn').disabled = false;
            document.getElementById('support-send-btn').textContent = 'Send Message';
            supportShowSection('support-form-section');
        }

        function proceedBillingToForm(selName) {
            const template = 'I purchased access to ' + selName + ' but the premium map is not unlocking when I zoom in. Please help.';
            showSupportFormStep(selName, template);
        }

        // The database says this pass is LIVE, so the overwhelmingly likely cause is a stale
        // edge token: the mmp-token in this browser was minted before the purchase, so
        // CloudFront 403s tiles the database agrees they own. That is fixable from right here
        // — offer the fix before offering an email.
        var _supportFixValveTimer = null;
        function showSupportFixStep(sel) {
            supportRefreshAttempted = false;
            const entry = findPurchaseEntry(sel.pid);
            const until = (entry && entry.expiry)
                ? new Date(entry.expiry).toLocaleString('en-IN', {
                    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
                })
                : '';
            document.getElementById('support-fix-text').innerHTML =
                'Good news &mdash; our records show your access to <strong>' + supportEsc(sel.name)
                + '</strong> is active' + (until ? ' until <strong>' + supportEsc(until) + '</strong>' : '')
                + '.<br><br>When a paid map still will not unlock, it is almost always because this '
                + 'browser is holding an older copy of your access. Let us refresh it for you.';
            const result = document.getElementById('support-fix-result');
            result.style.display = 'none';
            result.innerHTML = '';
            document.getElementById('support-fix-proceed').style.display = 'none';
            const refreshBtn = document.getElementById('support-fix-refresh');
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Refresh my access now';
            supportShowSection('support-fix-section');

            // Safety valve. If the refresh hangs (dead network, wedged callable) the customer
            // must never be trapped in a step with no way out — reveal the support route
            // regardless after 10s. Cheap insurance against turning a support gate into a
            // support blocker.
            if (_supportFixValveTimer) clearTimeout(_supportFixValveTimer);
            _supportFixValveTimer = setTimeout(function () {
                const p = document.getElementById('support-fix-proceed');
                if (p) p.style.display = '';
            }, 10000);
        }

        // No record of this purchase anywhere. Let them through to support, but ask for the
        // receipt first — that is the one thing that makes an untraceable claim traceable.
        function showSupportProofStep(sel) {
            clearSupportProof();
            document.getElementById('support-proof-region').textContent = sel.name;
            document.getElementById('support-proof-email').textContent =
                (currentUser && currentUser.email) ? currentUser.email : '';
            supportShowSection('support-proof-section');
        }

        function openSupportForm(district, returnToPaywall) {
            if (!currentUser || currentUser.isAnonymous) {
                pendingSupportOpen = { district: district, returnToPaywall: !!returnToPaywall };
                document.getElementById('auth-dialog-desc').textContent = 'Please sign in to contact support.';
                document.getElementById('auth-dialog-weblabel').style.display = 'none';
                document.getElementById('auth-dialog-overlay').classList.add('open');
                return;
            }
            supportReturnToPaywall = !!returnToPaywall;
            supportPaywallDistrict = district;
            document.getElementById('support-email').value = currentUser ? currentUser.email : '';
            resetSupportFlow();
            supportShowSection('support-choice-section');
            document.getElementById('support-dialog-overlay').classList.add('open');
        }

        function closeSupportForm() {
            document.getElementById('support-dialog-overlay').classList.remove('open');
            if (supportReturnToPaywall && supportPaywallDistrict) {
                showZoomRestrictionDialog(supportPaywallDistrict);
            } else {
                // Always restore map interaction when not re-showing the paywall. The
                // send-success path clears supportReturnToPaywall, so the old
                // "else if (supportReturnToPaywall)" branch was skipped after sending —
                // leaving the map with scrollwheel/zoomControl/gestureHandling off
                // (dead scroll-zoom + missing zoom buttons until reload).
                enableMapInteraction();
            }
            supportReturnToPaywall = false;
            supportPaywallDistrict = null;
            resetSupportFlow();
        }

        document.getElementById('support-send-btn').addEventListener('click', async () => {
            const msg = document.getElementById('support-message').value.trim();
            if (!msg) { alert('Please enter a message.'); return; }
            const btn = document.getElementById('support-send-btn');
            btn.disabled = true;
            btn.textContent = 'Sending...';

            const district = findDistrictAtCenter();

            function planLabelFor(plan) {
                if (plan === 'subscription') return 'Subscription';
                if (plan === 'professional') return 'Pro Pass (Android)';
                if (plan === 'web') return 'Web Pass (7-day)';
                if (plan === 'override') return 'Admin Override';
                return '7-Day Pass';
            }
            const activeEntries = [];
            activePurchases.forEach(function(val, pid) {
                const districtMatch = findDistrictByPurchaseId(pid);
                const entry = {
                    productId: pid,
                    name: districtMatch ? districtMatch.districtName : pid,
                    plan: val.plan || '',
                    planLabel: planLabelFor(val.plan),
                    expiry: val.expiry || 0,
                    refunded: !!val.refunded
                };
                if (val.plan === 'subscription') {
                    const sub = activeSubscriptions.get(pid);
                    if (sub) {
                        entry.status = sub.status || 'active';
                        entry.currentPeriodStart = sub.currentPeriodStart || null;
                        entry.currentPeriodEnd = sub.currentPeriodEnd || null;
                    }
                }
                activeEntries.push(entry);
            });

            const supportCenter = map ? map.getCenter() : null;

            // Region the user is actually viewing right now (viewport center). Independent of
            // regionPid, which the Billing flow overrides to the user's *claimed* region — so
            // support can see "claims Pune, but actually on PMRDA".
            const accessedRegionPid  = district ? (district.productPurchaseID || '') : '';
            const accessedRegionName = district ? (district.districtName || district.district || '') : '';

            // Classic "viewing a region you don't own while holding a pass for its confused
            // partner" case (on PMRDA but owning a Pune pass). Reuse existing helpers.
            let accessConfusion = null;
            if (accessedRegionPid && !hasPurchase(accessedRegionPid)) {
                const conf = confusionPartners(accessedRegionPid);
                for (let i = 0; i < conf.partners.length; i++) {
                    if (hasPurchase(conf.partners[i])) {
                        const pm = findDistrictByPurchaseId(conf.partners[i]);
                        accessConfusion = {
                            accessedName: accessedRegionName || accessedRegionPid,
                            accessedPid:  accessedRegionPid,
                            ownedName:    pm ? pm.districtName : conf.partners[i],
                            ownedPid:     conf.partners[i],
                            area:         conf.area || 'area'
                        };
                        break;
                    }
                }
            }

            // For the Billing flow, attach the record-check context to the message and
            // report the *selected* region (what the user is trying to access).
            let fullMsg = msg;
            let regionPidVal = district ? district.productPurchaseID : '';
            if (supportFlowMode === 'billing' && supportBillingSelection) {
                regionPidVal = supportBillingSelection.pid;
                fullMsg += '\n\n----- Billing context (auto-attached) -----\n'
                    + 'Problem type: Billing — paid but not working\n'
                    + 'Selected region (trying to access): ' + supportBillingSelection.name + ' (' + supportBillingSelection.pid + ')\n'
                    + (supportBillingRecordNote ? supportBillingRecordNote + '\n' : '')
                    + (supportBillingNoRecord ? 'Flag: NO_RECORD_FOR_SELECTED_REGION\n' : '');
            }

            try {
                const sendSupportRequest = functions.httpsCallable('sendSupportRequest');
                await sendSupportRequest({
                    message: fullMsg,
                    senderName: (currentUser && currentUser.displayName) ? currentUser.displayName : '',
                    region: document.getElementById('support-region').value,
                    regionPid: regionPidVal,
                    zoom: map ? map.getZoom() : 0,
                    lat: supportCenter ? supportCenter.lat() : null,
                    lng: supportCenter ? supportCenter.lng() : null,
                    userAgent: navigator.userAgent,
                    activeSubscriptions: activeEntries,
                    accessedRegionName: accessedRegionName,
                    accessedRegionPid:  accessedRegionPid,
                    accessConfusion:    accessConfusion,
                    screenshot:         supportProofB64 || null,
                    screenshotName:     supportProofName || null
                });
                document.getElementById('support-success-email').textContent = (currentUser && currentUser.email) ? currentUser.email : '';
                document.getElementById('support-form-section').style.display = 'none';
                document.getElementById('support-success-section').style.display = '';
                supportReturnToPaywall = false;
                supportPaywallDistrict = null;
            } catch (e) {
                btn.disabled = false;
                btn.textContent = 'Send Message';
                alert('Failed to send: ' + (e.message || 'Please try again.'));
            }
        });

        document.getElementById('support-cancel-btn').addEventListener('click', () => {
            closeSupportForm();
        });

        document.getElementById('support-success-close-btn').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Push a sacrificial history entry so the overlay-dismiss observer's
            // history.back() pops this instead of navigating away from maps.html.
            // Without this, a PWA/standalone launch or freshly-opened tab with no
            // prior history treats back-from-dialog as "close the tab".
            try { history.pushState({ mmDialog: 'support-close-shim' }, ''); } catch (_) {}
            closeSupportForm();
        });

        // --- Guided support flow: choice / billing / confusion steps ---
        document.getElementById('support-choice-cancel').addEventListener('click', () => {
            closeSupportForm();
        });

        document.getElementById('support-choice-other').addEventListener('click', () => {
            supportFlowMode = 'other';
            supportBillingSelection = null;
            supportBillingNoRecord = false;
            supportBillingRecordNote = '';
            const d = supportPaywallDistrict || findDistrictAtCenter();
            showSupportFormStep(d ? (d.districtName || d.district) : null, '');
        });

        document.getElementById('support-choice-billing').addEventListener('click', () => {
            supportFlowMode = 'billing';
            supportBillingSelection = null;
            document.getElementById('support-billing-next').disabled = true;
            document.getElementById('support-region-search').value = '';
            renderSupportRegionList('');
            supportShowSection('support-billing-section');
        });

        document.getElementById('support-region-search').addEventListener('input', function () {
            renderSupportRegionList(this.value);
        });

        document.getElementById('support-billing-back').addEventListener('click', () => {
            supportShowSection('support-choice-section');
        });

        document.getElementById('support-billing-next').addEventListener('click', async () => {
            if (!supportBillingSelection) return;
            const sel = supportBillingSelection;

            // Re-read entitlement from the server BEFORE deciding anything. activePurchases is
            // an in-memory cache that can be 30s stale on a fresh tab and far older on one left
            // open, and the whole point of the branches below is to be right about whether this
            // customer actually holds this pass. force=true also skips the fetch cooldown and
            // re-issues the edge token when the set has changed — which on its own resolves a
            // good share of "I paid but it's locked" reports.
            const nextBtn = document.getElementById('support-billing-next');
            const nextLabel = nextBtn.textContent;
            nextBtn.disabled = true;
            nextBtn.textContent = 'Checking your purchase…';
            try {
                await fetchPurchaseStatus(true, sel.pid);
            } catch (e) {
                // Network trouble: fall through and decide on the cached set rather than
                // stranding a customer who may genuinely need help.
                console.warn('Support pre-send purchase check failed:', e);
            }
            nextBtn.disabled = false;
            nextBtn.textContent = nextLabel;

            // Confusion check (selection ↔ viewport): the region the user says they paid for
            // differs from the region currently centered on the map, and the two are known
            // confusables (selected Pune but viewing PMRDA, or vice versa). Catch this even
            // when they own the selection — it's the exact mix-up behind the puzzling emails.
            const vp = findDistrictAtCenter();
            const vpPid = vp ? (vp.productPurchaseID || '') : '';
            const vpName = vp ? (vp.districtName || '') : '';
            const selPartners = confusionPartners(sel.pid);
            if (vpPid && normPid(vpPid) !== normPid(sel.pid)
                && selPartners.partners.map(normPid).indexOf(normPid(vpPid)) !== -1) {
                const vArea = selPartners.area || 'area';
                supportConfusionOwnedName = '';   // not an ownership-based confusion
                supportConfusionOwnedPid  = '';
                supportBillingNoRecord = false;
                supportBillingRecordNote =
                    'Record check: selected region ' + sel.name + ' (' + sel.pid + ') differs from the '
                    + 'region the user is viewing on the map ' + vpName + ' (' + vpPid + '); these are '
                    + 'confusables in the same ' + vArea + '. User confirmed they still want to email.';
                document.getElementById('support-confusion-text').innerHTML =
                    'You selected <strong>' + supportEsc(sel.name) + '</strong>, but the map is currently '
                    + 'centered on <strong>' + supportEsc(vpName) + '</strong>. These are separate map '
                    + 'regions within the same ' + supportEsc(vArea) + ', and a pass for one does not '
                    + 'unlock the other.<br><br>Please verify which region you actually need — if you meant '
                    + '<strong>' + supportEsc(vpName) + '</strong>, a separate pass or subscription is '
                    + 'required for it.<br><br>Are you sure you would still like to contact support?';
                supportShowSection('support-confusion-section');
                return;
            }

            // Case 1: user genuinely owns the selected region → offer the in-app fix first.
            // Support is still reachable from that step, but only after the refresh has been
            // tried, so the mail that does arrive is one the refresh could not solve.
            if (hasPurchase(sel.pid)) {
                supportBillingNoRecord = false;
                supportBillingRecordNote = 'Record check: user HAS an active pass/subscription for the selected region ('
                    + sel.name + ' / ' + sel.pid + '). Genuine access issue.';
                showSupportFixStep(sel);
                return;
            }

            // Case 2: user owns a commonly-confused partner region instead → warn before emailing.
            const confusion = confusionPartners(sel.pid);
            let ownedPartnerPid = null;
            for (let i = 0; i < confusion.partners.length; i++) {
                if (hasPurchase(confusion.partners[i])) { ownedPartnerPid = confusion.partners[i]; break; }
            }
            if (ownedPartnerPid) {
                const pm = findDistrictByPurchaseId(ownedPartnerPid);
                const ownedName = pm ? pm.districtName : ownedPartnerPid;
                const area = confusion.area || 'area';
                supportConfusionOwnedName = ownedName;
                supportConfusionOwnedPid = ownedPartnerPid;
                document.getElementById('support-confusion-text').innerHTML =
                    '<strong>' + supportEsc(sel.name) + '</strong> and <strong>' + supportEsc(ownedName)
                    + '</strong> are separate map regions within the same ' + supportEsc(area)
                    + '. Access to one region does not automatically include access to the other.<br><br>'
                    + 'Our records show that your active pass is for <strong>' + supportEsc(ownedName)
                    + '</strong>, while the region currently selected in the app is <strong>' + supportEsc(sel.name) + '</strong>.<br><br>'
                    + 'Please verify whether you intended to open the <strong>' + supportEsc(sel.name)
                    + '</strong> region. If so, a separate pass or subscription is required for that region.<br><br>'
                    + 'Are you sure you would still like to contact support?';
                supportShowSection('support-confusion-section');
                return;
            }

            // Case 3: no record at all → ask for the payment receipt before letting them email.
            supportBillingNoRecord = true;
            supportBillingRecordNote = 'Record check: NO active purchase found for the selected region ('
                + sel.name + ' / ' + sel.pid + ').';
            showSupportProofStep(sel);
        });

        document.getElementById('support-confusion-back').addEventListener('click', () => {
            supportShowSection('support-billing-section');
        });

        document.getElementById('support-confusion-confirm').addEventListener('click', () => {
            const sel = supportBillingSelection;
            supportBillingNoRecord = false;
            if (supportConfusionOwnedPid) {
                // ownership-based confusion (Case 2): user owns a confused partner, not the selection.
                supportBillingRecordNote = 'Record check: user does NOT own selected region (' + sel.name + ' / ' + sel.pid
                    + '); user OWNS confused partner ' + supportConfusionOwnedName + ' (' + supportConfusionOwnedPid + '). '
                    + 'User confirmed they still want to email.';
            }
            // else: viewport-mismatch confusion — supportBillingRecordNote already set at show time.
            proceedBillingToForm(sel.name);
        });

        // --- Step 3b handlers: the pass is live, try the fix before emailing ---------------
        document.getElementById('support-fix-back').addEventListener('click', () => {
            supportShowSection('support-billing-section');
        });

        document.getElementById('support-fix-reload').addEventListener('click', () => {
            location.reload();
        });

        document.getElementById('support-fix-refresh').addEventListener('click', async () => {
            const sel = supportBillingSelection;
            if (!sel) return;
            const btn = document.getElementById('support-fix-refresh');
            const result = document.getElementById('support-fix-result');
            btn.disabled = true;
            btn.textContent = 'Refreshing…';
            try {
                // Same two calls the post-purchase path uses: re-read entitlement, then re-mint
                // the CloudFront/mmp-token and tear down the DP overlays so tiles are refetched
                // with it. This is the actual cure for a stale-token lockout.
                await fetchPurchaseStatus(true, sel.pid);
                await syncEdgeToEntitlements(sel.pid);
                checkAndReenableMap();
                result.innerHTML = 'Your access has been refreshed. Close this dialog and zoom in on <strong>'
                    + supportEsc(sel.name) + '</strong> again &mdash; the premium map should now load.';
            } catch (e) {
                console.warn('Support access refresh failed:', e);
                result.innerHTML = 'We could not complete the refresh (there may be a network problem). '
                    + 'Please try <strong>Reload the page</strong>, or contact support below.';
            }
            result.style.display = '';
            supportRefreshAttempted = true;
            document.getElementById('support-fix-proceed').style.display = '';
            btn.disabled = false;
            btn.textContent = 'Refresh again';
        });

        document.getElementById('support-fix-proceed').addEventListener('click', () => {
            const sel = supportBillingSelection;
            if (!sel) return;
            const when = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            supportBillingRecordNote = 'Record check: user HAS an active pass/subscription for the selected region ('
                + sel.name + ' / ' + sel.pid + '). Genuine access issue. '
                + (supportRefreshAttempted
                    ? 'In-app access refresh (purchase re-fetch + edge token re-issue + tile reload) was attempted at '
                      + when + ' and did NOT resolve it.'
                    : 'The in-app access refresh did not complete before the user proceeded.');
            proceedBillingToForm(sel.name);
        });

        // --- Step 3c handlers: no purchase on record, ask for the receipt -----------------
        document.getElementById('support-proof-back').addEventListener('click', () => {
            supportShowSection('support-billing-section');
        });

        document.getElementById('support-proof-pick').addEventListener('click', () => {
            document.getElementById('support-proof-file').click();
        });

        document.getElementById('support-proof-file').addEventListener('change', async function () {
            const err = document.getElementById('support-proof-error');
            const pick = document.getElementById('support-proof-pick');
            const file = this.files && this.files[0];
            if (!file) return;
            err.style.display = 'none';
            err.textContent = '';
            pick.disabled = true;
            pick.textContent = 'Processing…';
            try {
                const out = await supportPrepareScreenshot(file);
                if (supportProofUrl) { try { URL.revokeObjectURL(supportProofUrl); } catch (e) {} }
                supportProofB64 = out.b64;
                supportProofBytes = out.bytes;
                supportProofUrl = out.url;
                supportProofName = 'payment-screenshot.jpg';
                document.getElementById('support-proof-thumb').src = out.url;
                document.getElementById('support-proof-meta').textContent =
                    'Screenshot attached — ' + Math.max(1, Math.round(out.bytes / 1024)) + ' KB';
                document.getElementById('support-proof-preview').style.display = 'flex';
                document.getElementById('support-proof-next').disabled = false;
            } catch (e) {
                err.textContent = e.message || 'Could not attach that image.';
                err.style.display = '';
                this.value = '';
            }
            pick.disabled = false;
            pick.textContent = supportProofB64 ? 'Choose a different screenshot' : 'Attach payment screenshot';
        });

        document.getElementById('support-proof-remove').addEventListener('click', () => {
            clearSupportProof();
            document.getElementById('support-proof-pick').textContent = 'Attach payment screenshot';
        });

        // Escape hatch. A customer on a locked-down phone who genuinely cannot produce a
        // screenshot must still be able to reach a human; the mail records that they said so.
        document.getElementById('support-proof-skip').addEventListener('click', () => {
            supportProofDeclined = true;
            document.getElementById('support-proof-next').disabled = false;
            const err = document.getElementById('support-proof-error');
            err.style.color = '#5f6368';
            err.textContent = 'No problem — you can continue without a screenshot. Please describe your payment (date, amount and how you paid) in the message.';
            err.style.display = '';
        });

        document.getElementById('support-proof-next').addEventListener('click', () => {
            const sel = supportBillingSelection;
            if (!sel) return;
            supportBillingNoRecord = true;
            supportBillingRecordNote = 'Record check: NO active purchase found for the selected region ('
                + sel.name + ' / ' + sel.pid + '). '
                + (supportProofB64
                    ? 'Customer attached a payment screenshot (see attachment).'
                    : 'Customer stated they cannot attach a screenshot.');
            proceedBillingToForm(sel.name);
        });
    window.mmSupport = { open: openSupportForm };
})();