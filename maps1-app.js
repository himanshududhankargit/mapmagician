        // Global embed mode flag (checked before auth/session logic)
        const isEmbedMode = new URLSearchParams(window.location.search).get('embed') === '1';

        // App version stamp — rendered into the Settings panel header so we can confirm at a
        // glance that the freshly-deployed JS (not a stale cached copy) is the one running.
        // Global build counter (like Android versionCode): +1 on EVERY push; only the file
        // actually deployed in that push gets the new number. maps1 (staging) and maps (live)
        // therefore hold the build number of their own most recent deploy. A staging (maps1) bump
        // = higher of live maps-app.js and staging maps1-app.js, + 1, so the counter stays globally
        // monotonic across both files. Live and staging both at 011 -> max(011,011)+1 = this push is 012. Next -> 013.
        var APP_VERSION = '012';

        // --- Auth & Payment ---
        const googleProvider = new firebase.auth.GoogleAuthProvider();
        googleProvider.setCustomParameters({ prompt: 'select_account' });
        const functions = firebase.app().functions('asia-south1');
        let currentUser = null;
        const ADMIN_EMAIL = "himanshududhankar@gmail.com";
        const activePurchases = new Map(); // productId → { expiry, plan }
        const cachedPricing = new Map();   // productId → price (pre-fetched at startup)
        const activeSubscriptions = new Map(); // productId → subscription metadata from GISWebSubscriptions
        const cachedSubPricing = new Map(); // productId → { weeklyPrice } (pre-fetched at startup)
        let cachedIdToken = null; // Firebase ID token for tile proxy auth
        let pendingPurchase = null; // { productId, regionName } — set when buy clicked before login
        let pendingVillageAfterDP = null; // villageItem — set when village needs DP purchase first
        let pendingSupportOpen = null; // {district, returnToPaywall} — set when support clicked before login
        let currentSessionId = null;  // Single-session enforcement
        let sessionListenerRef = null; // Firebase .on() ref for session changes
        var purchaseListenerRef = null; // Firebase .on() ref for realtime purchase updates

        // Anonymous sign-in is handled in onAuthStateChanged (after session restoration)

        // Auth dialog button handlers
        document.getElementById('auth-dialog-signin').addEventListener('click', () => {
            document.getElementById('auth-dialog-overlay').classList.remove('open');
            triggerGoogleSignIn();
        });
        document.getElementById('auth-dialog-cancel').addEventListener('click', () => {
            document.getElementById('auth-dialog-overlay').classList.remove('open');
            pendingPurchase = null;
            pendingSupportOpen = null;
        });

        // Floating button click — dynamic: sign-in or unlock region
        var _floatingBtnMode = 'signin'; // 'signin' or 'unlock'
        var _floatingBtnDistrict = null;
        document.getElementById('floating-signin-btn').addEventListener('click', function() {
            if (_floatingBtnMode === 'unlock' && _floatingBtnDistrict) {
                // Show paywall dialog — it handles sign-in internally via buyRegion/subscribeRegion
                showZoomRestrictionDialog(_floatingBtnDistrict);
            } else {
                triggerGoogleSignIn();
            }
        });

        // Trigger sign-in via Firebase popup (works on all domains without extra OAuth config)
        function triggerGoogleSignIn() {
            firebase.auth().signInWithPopup(googleProvider).catch(err => {
                console.error('Login failed:', err);
                if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
                    alert('Sign-in could not be completed. Please try again.');
                }
            });
        }

        // Auth state listener
        firebase.auth().onAuthStateChanged(user => {
            // In embed mode, skip all auth UI/session/purchase logic — just load tiles
            if (isEmbedMode) {
                currentUser = user;
                if (!user) {
                    firebase.auth().signInAnonymously().catch(function() {});
                } else if (!user.isAnonymous) {
                    fetchCloudFrontCookies();
                } else {
                    fetchCloudFrontCookies();
                }
                return;
            }

            currentUser = user;
            const profileBtn = document.getElementById('profile-btn');
            const profileIcon = document.getElementById('profile-btn-icon');

            const profileSvg = document.getElementById('profile-btn-svg');

            // Floating button — will be updated by updateRegionStatus() on next idle
            // For immediate feedback: hide if signed in (updateRegionStatus will show unlock if needed)
            var floatingSignin = document.getElementById('floating-signin-btn');
            if (floatingSignin) {
                if (user && !user.isAnonymous) floatingSignin.style.display = 'none';
                else floatingSignin.style.display = 'flex';
            }
            // Update settings panel account section
            var settingsSignedOut = document.getElementById('settings-signed-out');
            var settingsSignedIn = document.getElementById('settings-signed-in');
            if (user && !user.isAnonymous) {
                settingsSignedOut.style.display = 'none';
                settingsSignedIn.style.display = 'block';
                document.getElementById('settings-user-email').textContent = user.email || '';
            } else {
                settingsSignedOut.style.display = 'block';
                settingsSignedIn.style.display = 'none';
            }

            if (user && !user.isAnonymous) {
                // Google-signed-in user — show avatar or initial
                profileBtn.classList.add('signed-in');
                profileSvg.style.display = 'none';
                if (user.photoURL) {
                    profileIcon.textContent = '';
                    const avatarImg = document.createElement('img');
                    avatarImg.src = user.photoURL;
                    avatarImg.referrerPolicy = 'no-referrer';
                    profileIcon.appendChild(avatarImg);
                    profileBtn.style.background = 'none';
                } else {
                    profileIcon.textContent = user.displayName ? user.displayName.charAt(0) : 'U';
                    profileBtn.style.background = '#e8f5e9';
                    profileBtn.style.color = '#2E7D32';
                    profileIcon.style.fontSize = '14px';
                }
                profileBtn.title = user.displayName || user.email;
                fetchCloudFrontCookies();
                if (user.email) registerSession(user.email);

                // Realtime listener: re-fetch when purchases change server-side (admin refund, webhook, etc.)
                var emailKey = user.email.replace(/\./g, ',');

                // Analytics: tag the signed-in user + domain-derived props
                try {
                    var emailDomain = (user.email.split('@')[1] || '').toLowerCase();
                    mmAnalytics.setUserId(emailKey);
                    mmAnalytics.setUserProperties({
                        auth_method: 'google',
                        email_domain: emailDomain
                    });
                    mmAnalytics.clarityTag('auth', 'google');
                    mmAnalytics.clarityTag('email_domain', emailDomain);
                } catch (e) {}
                if (purchaseListenerRef) purchaseListenerRef.off();
                purchaseListenerRef = firebase.database().ref('GISWebOneTimePurchases/' + emailKey);
                var purchaseListenerSkipFirst = true; // Skip the initial .on() callback
                purchaseListenerRef.on('value', function() {
                    if (purchaseListenerSkipFirst) { purchaseListenerSkipFirst = false; return; }
                    // Data changed server-side — refresh everything
                    fetchPurchaseStatus(true).then(function() {
                        loadTilesBasedOnViewport();
                        updateRegionStatus();
                    });
                    fetchSubscriptionStatus();
                    fetchPurchaseHistory();
                });

                // Show loading while fetching purchase data
                const authLoadingOverlay = document.getElementById('payment-loading-overlay');
                document.getElementById('payment-loading-text').textContent = 'Loading your account...';
                document.getElementById('payment-loading-sub').textContent = user.email || '';
                authLoadingOverlay.classList.add('open');

                // Fire-and-forget: delete this user's expired purchases server-side.
                // Bounded to the caller's own emailKey; runs once per session.
                if (!window.__cleanupFiredThisSession) {
                    window.__cleanupFiredThisSession = true;
                    functions.httpsCallable('cleanupMyExpiredPurchases')()
                        .catch(function(err) { console.warn('Self-cleanup failed:', err && err.message); });
                }

                // Wait for purchases to load, THEN resume pending actions
                fetchVillagePurchases(); // also load village purchase status
                fetchSubscriptionStatus(); // load subscription metadata
                fetchPurchaseHistory(); // load purchase history for sidebar
                fetchPurchaseStatus(true).then(function() {
                    authLoadingOverlay.classList.remove('open');
                    // Reset overlay text for future payment use
                    document.getElementById('payment-loading-text').textContent = 'Preparing your payment...';
                    document.getElementById('payment-loading-sub').textContent = '7-Day Pass';

                    // Resume pending purchase after purchases are loaded
                    if (pendingPurchase) {
                        const pp = pendingPurchase;
                        pendingPurchase = null;
                        if (pp.purchaseType === 'village') {
                            buyVillage(pp.villageName);
                        } else if (pp.purchaseType === 'subscription') {
                            subscribeRegion(pp.productId, pp.regionName);
                        } else {
                            buyRegion(pp.productId, pp.regionName);
                        }
                    }
                    // Resume pending support form
                    if (pendingSupportOpen) {
                        const ps = pendingSupportOpen;
                        pendingSupportOpen = null;
                        openSupportForm(ps.district, ps.returnToPaywall);
                    }
                }).catch(function() {
                    authLoadingOverlay.classList.remove('open');
                    document.getElementById('payment-loading-text').textContent = 'Preparing your payment...';
                    document.getElementById('payment-loading-sub').textContent = '7-Day Pass';
                });
            } else if (user && user.isAnonymous) {
                // Anonymous user — fetch cookies first, then load tiles
                profileBtn.classList.remove('signed-in');
                profileSvg.style.display = '';
                profileIcon.innerHTML = '';
                profileIcon.textContent = 'Sign In';
                profileBtn.style.background = '#e3f2fd';
                profileBtn.style.color = '#1976D2';
                profileBtn.title = 'Sign in';
                villagePurchases.clear();
                clearAllLayersOfType(villageOverlays);
                villageTileStatus = Array(villageLayerData.length).fill(false);
                updateVillageMarkerStyles();
                try {
                    mmAnalytics.setUserProperties({ auth_method: 'anonymous' });
                    mmAnalytics.clarityTag('auth', 'anonymous');
                } catch (e) {}
                fetchCloudFrontCookies();
            } else {
                profileBtn.classList.remove('signed-in');
                profileSvg.style.display = '';
                profileIcon.innerHTML = '';
                profileIcon.textContent = 'Sign In';
                profileBtn.style.background = '#e3f2fd';
                profileBtn.style.color = '#1976D2';
                profileBtn.title = 'Sign in';
                activePurchases.clear();
                activeSubscriptions.clear();
                villagePurchases.clear();
                cachedIdToken = null;
                clearSession();
                // Hide purchases and close settings panel if open
                var purchSec = document.getElementById('settings-purchases-section');
                if (purchSec) purchSec.style.display = 'none';
                var sp = document.getElementById('settings-panel');
                var so = document.getElementById('settings-overlay');
                if (sp) sp.classList.remove('open');
                if (so) so.classList.remove('open');
                // Detach pricing listener to prevent unnecessary reads
                if (typeof pricingListenerRef !== 'undefined') pricingListenerRef.off();
                if (typeof subPricingRef !== 'undefined') subPricingRef.off();
                // Clear village tiles (don't load tiles yet — signInAnonymously will trigger cookie fetch + tile load)
                clearAllLayersOfType(villageOverlays);
                villageTileStatus = Array(villageLayerData.length).fill(false);
                updateVillageMarkerStyles();

                // Clear CloudFront cookies on sign-out
                cfCookiesReady = false;
                document.cookie = `CloudFront-Policy=; domain=${COOKIE_DOMAIN}; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
                document.cookie = `CloudFront-Signature=; domain=${COOKIE_DOMAIN}; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
                document.cookie = `CloudFront-Key-Pair-Id=; domain=${COOKIE_DOMAIN}; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
                document.cookie = `mmp-token=; domain=${COOKIE_DOMAIN}; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;

                // Sign in anonymously for free tile access
                firebase.auth().signInAnonymously().catch(err => {
                    console.error('Anonymous sign-in failed:', err);
                });
            }
        });

        // Fetch CloudFront signed cookies after login, with auto-refresh
        let cfCookieRefreshTimer = null;
        async function fetchCloudFrontCookies() {
            // Start layer data fetch immediately — it only needs auth, not cookies
            fetchLayerData();
            try {
                var als = document.getElementById('app-loading-status');
                if (als) als.textContent = 'Connecting to tile server...';
                const getCloudFrontCookies = functions.httpsCallable('getCloudFrontCookies');
                const result = await getCloudFrontCookies();
                const data = result.data;
                const expires = new Date(data.expiresAt).toUTCString();

                document.cookie = `CloudFront-Policy=${data['CloudFront-Policy']}; domain=${COOKIE_DOMAIN}; path=/; secure; samesite=none; expires=${expires}`;
                document.cookie = `CloudFront-Signature=${data['CloudFront-Signature']}; domain=${COOKIE_DOMAIN}; path=/; secure; samesite=none; expires=${expires}`;
                document.cookie = `CloudFront-Key-Pair-Id=${data['CloudFront-Key-Pair-Id']}; domain=${COOKIE_DOMAIN}; path=/; secure; samesite=none; expires=${expires}`;
                if (data['mmp-token']) {
                    document.cookie = `mmp-token=${data['mmp-token']}; domain=${COOKIE_DOMAIN}; path=/; secure; samesite=none; expires=${expires}`;
                }

                if (!cfCookiesReady) {
                    cfCookiesReady = true;
                    // Layer data already fetching in parallel — now cookies are set, trigger tile load
                    loadTilesBasedOnViewport();
                    // Dismiss loading screen after layer data triggers first tile load
                    setTimeout(function() {
                        var ls = document.getElementById('app-loading-screen');
                        if (ls) {
                            ls.style.opacity = '0';
                            setTimeout(function() {
                                // display:none instead of remove() — keeps splash banner
                                // as the LCP candidate so PageSpeed reports LCP at first
                                // paint (~1.4s) rather than at element-removal time (~7s).
                                ls.style.display = 'none';
                                ls.style.pointerEvents = 'none';
                                if (typeof window._showDisclaimer === 'function') window._showDisclaimer();
                            }, 500);
                        }
                    }, 1500);
                }

                // Auto-refresh 1 hour before expiry
                if (cfCookieRefreshTimer) clearTimeout(cfCookieRefreshTimer);
                const refreshIn = data.expiresAt - Date.now() - 3600000; // 1 hour before
                if (refreshIn > 0) {
                    cfCookieRefreshTimer = setTimeout(() => {
                        fetchCloudFrontCookies();
                    }, refreshIn);
                }
            } catch (err) {
                if (err.code !== 'permission-denied') {
                    console.error('Failed to fetch CloudFront cookies:', err);
                }
            }
        }

        // Profile button click (sign in / sign out)
        document.getElementById('profile-btn').addEventListener('click', () => {
            if (currentUser && !currentUser.isAnonymous) {
                document.getElementById('signout-dialog-email').textContent = currentUser.email;
                document.getElementById('signout-dialog-overlay').classList.add('open');
            } else {
                document.getElementById('auth-dialog-desc').textContent =
                    'Sign in with your Google account to access premium maps, save purchases, and sync across devices.';
                document.getElementById('auth-dialog-weblabel').style.display = 'block';
                document.getElementById('auth-dialog-overlay').classList.add('open');
            }
        });
        document.getElementById('signout-dialog-confirm').addEventListener('click', () => {
            document.getElementById('signout-dialog-overlay').classList.remove('open');
            firebase.auth().signOut();
        });
        document.getElementById('signout-dialog-cancel').addEventListener('click', () => {
            document.getElementById('signout-dialog-overlay').classList.remove('open');
        });

        // --- Single-session enforcement ---
        function registerSession(email) {
            const emailKey = email.replace(/\./g, ',');
            currentSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : (Date.now() + '-' + Math.random().toString(36).slice(2));
            try { mmAnalytics.event('login', { method: 'google' }); } catch (e) {}
            const ref = firebase.database().ref('GISWebActiveSessions/' + emailKey);

            // Detach previous listener if any
            if (sessionListenerRef) sessionListenerRef.off();
            sessionListenerRef = ref;

            // Write our sessionId FIRST, then listen for changes
            // This prevents the listener from firing with the old value before set() completes
            ref.set(currentSessionId).then(function() {
                ref.on('value', function(snap) {
                    const val = snap.val();
                    if (val && val !== currentSessionId && currentUser && !currentUser.isAnonymous) {
                        // Another session superseded this one
                        ref.off();
                        sessionListenerRef = null;
                        showSessionExpiredDialog();
                    }
                });
            });
        }

        function clearSession() {
            if (sessionListenerRef) { sessionListenerRef.off(); sessionListenerRef = null; }
            if (purchaseListenerRef) { purchaseListenerRef.off(); purchaseListenerRef = null; }
            currentSessionId = null;
        }

        function showSessionExpiredDialog() {
            document.getElementById('session-expired-overlay').classList.add('open');
        }

        document.getElementById('session-expired-ok').addEventListener('click', function() {
            document.getElementById('session-expired-overlay').classList.remove('open');
            firebase.auth().signOut();
        });

        // Load purchase status via Cloud Function (DB paths hidden server-side)
        function loadPurchaseStatus(email) {
            fetchPurchaseStatus();
        }

        let lastFetchTime = 0;
        const FETCH_COOLDOWN_MS = 30000; // Don't re-fetch within 30 seconds

        // Re-check purchase + subscription status when user returns to the tab
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState !== 'visible') return;
            if (!currentUser || currentUser.isAnonymous) return;
            // Snapshot current state to compare after fetch
            var prevKeys = Array.from(activePurchases.entries()).map(function(e) {
                return e[0] + ':' + (e[1].refunded ? 'R' : e[1].expiry);
            }).sort().join(',');
            var prevVillageKeys = Array.from(villagePurchases.keys()).sort().join(',');
            Promise.all([
                fetchPurchaseStatus(true),
                fetchVillagePurchases(),
                fetchSubscriptionStatus(),
                fetchPurchaseHistory()
            ]).then(function() {
                var newKeys = Array.from(activePurchases.entries()).map(function(e) {
                    return e[0] + ':' + (e[1].refunded ? 'R' : e[1].expiry);
                }).sort().join(',');
                var newVillageKeys = Array.from(villagePurchases.keys()).sort().join(',');
                if (newKeys !== prevKeys || newVillageKeys !== prevVillageKeys) {
                    // Purchase data changed — reload tiles + update UI
                    clearAllLayersOfType(villageOverlays);
                    villageTileStatus = Array(villageLayerData.length).fill(false);
                    loadTilesBasedOnViewport();
                    updateVillageMarkerStyles();
                    updateRegionStatus();
                }
            });
        });

        let _fetchingPurchases = false;
        async function fetchPurchaseStatus(force) {
            if (!currentUser || currentUser.isAnonymous) return;
            const now = Date.now();
            if (!force && now - lastFetchTime < FETCH_COOLDOWN_MS) return;
            if (_fetchingPurchases) return; // prevent concurrent calls
            _fetchingPurchases = true;
            lastFetchTime = now;

            try {
                const getPurchaseStatus = functions.httpsCallable('getPurchaseStatus');
                const { data } = await getPurchaseStatus();
                activePurchases.clear();
                Object.entries(data.purchases || {}).forEach(([productId, val]) => {
                    // Handle both old format (number) and new format ({expiry, plan})
                    if (typeof val === 'object' && val) {
                        activePurchases.set(productId, { expiry: val.expiry, plan: val.plan || '', refunded: val.refunded || false });
                    } else {
                        activePurchases.set(productId, { expiry: val, plan: '' });
                    }
                });
                refreshSidebarIfOpen();
                // Evict cached tiles for districts the user no longer has access
                // to (refunds, expiries). Free tiles and still-purchased districts
                // are preserved. Fire-and-forget — cache correctness is eventually
                // consistent with purchase state.
                revokeTilesNotInFolderSet(_computeAllowedTileFolders());
                // Only re-enable map and force re-check after an actual purchase (force=true),
                // not on routine region-change polls which would cause spurious unlock toasts
                if (force) {
                    checkAndReenableMap();
                    lastCheckedRegionId = null;
                    stickyTile = null;
                    stickyDistrict = null;
                    checkRegionOnMove();
                }
            } catch (e) {
                console.error('Failed to fetch purchase status:', e);
            } finally {
                _fetchingPurchases = false;
            }
        }

        // --- Subscription status ---
        async function fetchSubscriptionStatus() {
            if (!currentUser || currentUser.isAnonymous) {
                activeSubscriptions.clear();
                try { updateGraceRenewBanner(); } catch (e) { /* non-fatal */ }
                return;
            }
            try {
                var getSubscriptionStatus = functions.httpsCallable('getSubscriptionStatus');
                var result = await getSubscriptionStatus();
                activeSubscriptions.clear();
                Object.entries(result.data.subscriptions || {}).forEach(function(e) {
                    activeSubscriptions.set(e[0], e[1]);
                });
            } catch (e) {
                console.error('Failed to fetch subscription status:', e);
            }
            try { updateGraceRenewBanner(); } catch (e) { /* non-fatal */ }
        }

        // Show a banner above #bottom-bar when any subscription is in the 3-day grace
        // window. Renew button reuses the same flow as the My Purchases panel's Renew
        // button. Dismiss is in-memory only — reloading the page brings the banner back
        // so users keep being reminded.
        var _graceBannerDismissed = false;
        function updateGraceRenewBanner() {
            var banner = document.getElementById('grace-renew-banner');
            if (!banner) return;
            if (!currentUser || currentUser.isAnonymous) {
                banner.style.display = 'none';
                return;
            }
            if (_graceBannerDismissed) {
                banner.style.display = 'none';
                return;
            }
            var graceSub = null, gracePid = null, graceName = null;
            activeSubscriptions.forEach(function(sub, pid) {
                if (graceSub) return;
                // Show the Renew banner for grace, halted OR pending — i.e.
                // any state the backend treats as recoverable by paying the
                // outstanding invoice (mirrors `recoverable` in
                // getSubscriptionRenewInvoice). A halted sub clears the grace
                // flags, so a grace-only check would never surface it.
                var needsRenew = sub && (
                    (sub.graceAppliedThisCycle && Number(sub.graceExpiry || 0) > Date.now())
                    || sub.status === 'halted'
                    || sub.status === 'pending');
                if (needsRenew) {
                    var district = (typeof findDistrictByPurchaseId === 'function')
                        ? findDistrictByPurchaseId(pid) : null;
                    graceSub = sub;
                    gracePid = pid;
                    // Use full district name so banner + Razorpay Checkout match the
                    // name shown in the My Purchases row.
                    graceName = district ? district.districtName : pid;
                }
            });
            if (!graceSub) {
                banner.style.display = 'none';
                return;
            }
            var regionEl = document.getElementById('grace-renew-banner-region');
            if (regionEl) regionEl.textContent = graceName;
            var bb = document.getElementById('bottom-bar');
            // 8px gap above bottom bar so the pill visually floats rather than touches.
            banner.style.bottom = ((bb ? bb.offsetHeight : 56) + 8) + 'px';
            banner.style.display = 'flex';

            var renewBtn = document.getElementById('grace-renew-banner-btn');
            if (renewBtn) {
                renewBtn.onclick = function() {
                    renewRegionSubscription(gracePid, graceName);
                };
            }
            var dismissBtn = document.getElementById('grace-renew-banner-dismiss');
            if (dismissBtn) {
                dismissBtn.onclick = function() {
                    _graceBannerDismissed = true;
                    banner.style.display = 'none';
                };
            }
        }

        var purchaseHistory = []; // Array of history entries from Firebase

        async function fetchPurchaseHistory() {
            if (!currentUser || currentUser.isAnonymous) { purchaseHistory = []; return; }
            try {
                var getPurchaseHistory = functions.httpsCallable('getPurchaseHistory');
                var result = await getPurchaseHistory();
                purchaseHistory = result.data.history || [];
            } catch (e) {
                console.error('Failed to fetch purchase history:', e);
            }
        }

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
            const search = document.getElementById('support-region-search');
            if (search) search.value = '';
            const nextBtn = document.getElementById('support-billing-next');
            if (nextBtn) nextBtn.disabled = true;
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
            } else if (supportReturnToPaywall) {
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
                    accessConfusion:    accessConfusion
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

        document.getElementById('support-billing-next').addEventListener('click', () => {
            if (!supportBillingSelection) return;
            const sel = supportBillingSelection;

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

            // Case 1: user genuinely owns the selected region → real technical issue.
            if (hasPurchase(sel.pid)) {
                supportBillingNoRecord = false;
                supportBillingRecordNote = 'Record check: user HAS an active pass/subscription for the selected region ('
                    + sel.name + ' / ' + sel.pid + '). Genuine access issue.';
                proceedBillingToForm(sel.name);
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

            // Case 3: no record at all → let them email, but flag it for support.
            supportBillingNoRecord = true;
            supportBillingRecordNote = 'Record check: NO active purchase found for the selected region ('
                + sel.name + ' / ' + sel.pid + ').';
            proceedBillingToForm(sel.name);
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

        // Placeholder -- set by initSidebar once sidebar is ready
        var refreshSidebarIfOpen = function() {};
        var openRegionsBrowser = function() {};

        // Re-enable map if current district becomes purchased
        function checkAndReenableMap() {
            if (!currentUser || currentUser.isAnonymous) return;
            const district = findDistrictAtCenter();
            if (district && hasPurchase(district.productPurchaseID)) {
                setMapMaxZoom(21);
                enableMapInteraction();
                document.getElementById('zoom-restrict-overlay').classList.remove('open');
                updateRegionStatus();
                showUnlockToast(district.districtName);
            } else {
                setMapMaxZoom(MAX_FREE_ZOOM);
            }
        }

        // Find matching entry in activePurchases (exact match only, with normalization)
        function findPurchaseEntry(productId) {
            if (!productId) return null;
            const pid = productId.toLowerCase().replace(/gst$/, '');
            const pidNoPrefix = pid.replace(/^district/, '');
            return activePurchases.get(pid) ||
                   activePurchases.get('district' + pid) ||
                   activePurchases.get(pidNoPrefix) ||
                   null;
        }

        // Check if a product is purchased (excludes refunded entries)
        function hasPurchase(productId) {
            var entry = findPurchaseEntry(productId);
            return entry !== null && !entry.refunded;
        }

        // Check Firebase DB directly for a purchase entry (handles mobile→web sync lag,
        // just-issued admin overrides, and cross-device purchases). Mirrors the
        // three-source filter in getPurchaseStatus/getActiveProductIntIds — if any
        // source has a live entry, we consider it an unlock.
        // skipBackgroundSync: when true (passed only by the zoom paywall re-check), the
        // fire-and-forget fetchPurchaseStatus(true) below is NOT run on a hit. That server
        // re-fetch can, while the server's getPurchaseStatus is still lagging RTDB, clear
        // and repopulate activePurchases WITHOUT the just-confirmed entry and re-clamp zoom
        // to 14 — a brief snap right after this fresh client read unlocked the map. We already
        // cached the entry (activePurchases.set) and refreshed the edge token, so the re-fetch
        // is redundant here; other callers keep it (default false). Safety unchanged: we only
        // reach this on a non-refunded, unexpired, authoritative grant.
        async function checkFirebasePurchaseEntry(productId, skipBackgroundSync) {
            if (!currentUser || currentUser.isAnonymous || !currentUser.email || !productId) return false;
            try {
                const emailKey = currentUser.email.replace(/\./g, ',');
                const now = Date.now();
                const [webSnap, overrideSnap, androidSnap] = await Promise.all([
                    firebase.database().ref('GISWebOneTimePurchases/' + emailKey + '/' + productId).once('value'),
                    firebase.database().ref('overrideGISMaharashtra/' + emailKey + '/districts/' + productId).once('value'),
                    firebase.database().ref('GISAPPOneTimePurchase/' + emailKey + '/' + productId).once('value'),
                ]);

                var entry = null;

                var webRaw = webSnap.val();
                if (webRaw) {
                    var webExp = typeof webRaw === 'number' ? webRaw : (webRaw.expiry || 0);
                    // Default empty/missing/number-format plan to 'web' and accept it —
                    // matches the server getPurchaseStatus, which treats a web node with no
                    // plan as 'web'. The old `webPlan !== ''` guard wrongly refused those,
                    // so the re-check could fail to rescue a genuinely-owned legacy entry.
                    var webPlan = (typeof webRaw === 'object') ? (webRaw.plan || 'web') : 'web';
                    var webRef = (typeof webRaw === 'object') ? (webRaw.refunded === true) : false;
                    if (!webRef && webExp > now && webPlan !== 'onetime') {
                        entry = { expiry: webExp, plan: webPlan };
                    }
                }

                if (!entry) {
                    var ovRaw = overrideSnap.val();
                    if (ovRaw && ovRaw.expiry) {
                        var ovExp = new Date(ovRaw.expiry).getTime();
                        if (ovExp > now) entry = { expiry: ovExp, plan: 'override' };
                    }
                }

                if (!entry) {
                    var aRaw = androidSnap.val();
                    if (aRaw) {
                        var aExp = typeof aRaw === 'number' ? aRaw : (aRaw.expiry || 0);
                        var aPlan = (typeof aRaw === 'object') ? (aRaw.plan || '') : '';
                        var aRef = (typeof aRaw === 'object') ? (aRaw.refunded === true) : false;
                        if (!aRef && aExp > now && aPlan !== 'onetime' && aPlan !== '') {
                            entry = { expiry: aExp, plan: aPlan };
                        }
                    }
                }

                // NOTE: active subscriptions need no separate read here — the
                // subscription.charged/confirm flow writes the granted expiry through to
                // GISWebOneTimePurchases with plan:"subscription" (functions/index.js:1717),
                // so the web read above already catches them. The only uncovered case is the
                // 3-day renewing bridge with a stale local cache, which self-heals via the
                // purchase listener; not worth an extra per-paywall read.
                if (!entry) return false;

                // Valid entry found — update in-memory cache and refresh mmp-token so
                // the edge gate lets the newly-allowed district's tiles through.
                activePurchases.set(productId, entry);
                // Await the cookie refresh — otherwise the caller will re-trigger tile
                // loads before the new JWT is installed, and tiles 403 at the edge.
                try { await fetchCloudFrontCookies(); } catch (e) { /* non-fatal; fall back to TTL-based refresh */ }
                // Full sync in background (covers other purchases + keeps activePurchases honest).
                // Skipped for the zoom paywall re-check (see skipBackgroundSync above) to avoid a
                // lagging-server re-clamp right after this read unlocked the map; other sync
                // triggers (auth, region change, tab focus, realtime listener) keep it honest.
                if (!skipBackgroundSync) fetchPurchaseStatus(true);
                return true;
            } catch (e) {
                console.error('checkFirebasePurchaseEntry error:', e);
                return false;
            }
        }

        // Get plan type for a purchased product
        function getPurchasePlan(productId) {
            const entry = findPurchaseEntry(productId);
            return entry ? (entry.plan || '') : '';
        }

        // Get expiry for a purchased product
        function getPurchaseExpiry(productId) {
            const entry = findPurchaseEntry(productId);
            return entry ? (entry.expiry || 0) : 0;
        }

        function calcDaysLeft(expiry) {
            var ms = Math.max(0, expiry - Date.now());
            var d = Math.floor(ms / 86400000);
            var h = Math.floor((ms % 86400000) / 3600000);
            var m = Math.floor((ms % 3600000) / 60000);
            if (d > 0) return d + 'd ' + h + 'h';
            if (h > 0) return h + 'h ' + m + 'm';
            return m + 'm';
        }

        function formatSubscriptionCountdown(expiry, status) {
            if (!expiry || expiry - Date.now() <= 0) return 'Expired';
            var date = new Date(expiry).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata'
            });
            var verb = (status && status !== 'active') ? 'Expires on ' : 'Renews on ';
            return verb + date;
        }

        // Buy a 7-day pass
        async function buyRegion(productId, regionName) {
            try {
                mmAnalytics.event('select_item', {
                    item_id: productId,
                    item_name: regionName,
                    item_category: 'dp_7day'
                });
            } catch (e) {}
            if (!currentUser || currentUser.isAnonymous) {
                // Show login dialog — store purchase intent so we can resume after sign-in
                pendingPurchase = { productId, regionName };
                document.getElementById('auth-dialog-desc').textContent =
                    'Sign in with your Google account to purchase the 7-Day Pass for ' + regionName + '.';
                document.getElementById('auth-dialog-weblabel').style.display = 'block';
                document.getElementById('auth-dialog-overlay').classList.add('open');
                return;
            }

            // Silent-unlock if already owned (e.g. pendingPurchase resumed after
            // login over a region the account already purchased on another device).
            // fetchPurchaseStatus(true) ran in the auth listener before this
            // re-trigger, so activePurchases is fresh — no need to call createOrder.
            if (hasPurchase(productId)) {
                document.getElementById('zoom-restrict-overlay').classList.remove('open');
                setMapMaxZoom(21);
                enableMapInteraction();
                showUnlockToast(regionName);
                try { await fetchCloudFrontCookies(); } catch (e) {}
                clearAllLayersOfType(dpOverlays);
                dpTileStatus = Array(dpLayerData.length).fill(false);
                loadTilesBasedOnViewport();
                lastCheckedRegionId = null;
                stickyTile = null;
                stickyDistrict = null;
                return;
            }

            // Show loading overlay
            const loadingOverlay = document.getElementById('payment-loading-overlay');
            document.getElementById('payment-loading-sub').textContent = '7-Day Pass: ' + regionName;
            loadingOverlay.classList.add('open');

            try {
                const createOrder = functions.httpsCallable('createOrder');
                const { data } = await createOrder({ productId, regionName });

                // Hide loading before Razorpay opens
                loadingOverlay.classList.remove('open');

                const options = {
                    key: 'rzp_live_SXr1BKnoysSo9r',
                    order_id: data.orderId,
                    amount: data.amount,
                    currency: data.currency || 'INR',
                    name: 'Development Plans (GIS)',
                    description: 'Web only (not Android) — 7-Day Pass: ' + regionName,
                    prefill: {
                        email: currentUser.email,
                        name: currentUser.displayName || ''
                    },
                    theme: { color: '#008577' },
                    handler: async function(response) {
                        updateStatus('Payment successful! Activating...');
                        try {
                            // Instantly verify and activate — no webhook wait
                            const confirmPayment = functions.httpsCallable('confirmPayment');
                            await confirmPayment({
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_order_id: response.razorpay_order_id,
                                razorpay_signature: response.razorpay_signature,
                                productId: productId,
                                regionName: regionName
                            });
                            try {
                                mmAnalytics.event('purchase', {
                                    transaction_id: response.razorpay_payment_id,
                                    value: (data.amount || 0) / 100,
                                    currency: data.currency || 'INR',
                                    items: [{ item_id: productId, item_name: regionName, item_category: 'dp_7day' }]
                                });
                                mmAnalytics.clarityTag('plan', 'paid');
                            } catch (e) {}
                            await fetchPurchaseStatus(true);
                            // Refresh CloudFront cookies + mmp-token so the new purchase's
                            // district is in the edge-verified claims cookie immediately
                            // (otherwise zoom 15+ tiles would 403 until the next TTL refresh).
                            await fetchCloudFrontCookies();
                            // Clear and reload tiles so they use the new access token
                            clearAllLayersOfType(dpOverlays);
                            dpTileStatus = Array(dpLayerData.length).fill(false);
                            loadTilesBasedOnViewport();
                            enableMapInteraction();
                            document.getElementById('zoom-restrict-overlay').classList.remove('open');
                            setMapMaxZoom(21); // unlock zoom after purchase
                            lastCheckedRegionId = null; // force re-evaluate
                            stickyTile = null;
                            stickyDistrict = null;
                            // Clear the paywall re-check debounce so an immediate re-zoom after
                            // paying always does a fresh read instead of being skipped for ~2s.
                            _lastFirebaseCheckPid = null;
                            updateStatus('Region activated!');
                            // If a village purchase was pending, show village dialog now
                            if (pendingVillageAfterDP) {
                                var villageToShow = pendingVillageAfterDP;
                                pendingVillageAfterDP = null;
                                setTimeout(function() {
                                    showVillagePurchaseDialog(villageToShow);
                                }, 500);
                            }
                        } catch (e) {
                            console.error('Confirm payment error:', e);
                            // Fallback: wait for webhook
                            setTimeout(() => fetchPurchaseStatus(true), 3000);
                            setTimeout(() => fetchPurchaseStatus(true), 8000);
                        }
                    },
                    modal: {
                        ondismiss: function() {
                            updateStatus('Payment cancelled');
                            pendingVillageAfterDP = null;
                        }
                    }
                };

                if (typeof Razorpay === 'undefined') {
                    // Razorpay script not loaded — try loading it dynamically
                    await new Promise(function(resolve, reject) {
                        const s = document.createElement('script');
                        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
                        s.onload = resolve;
                        s.onerror = function() { reject(new Error('Could not load payment gateway. Please check your internet connection or disable ad blocker.')); };
                        document.head.appendChild(s);
                    });
                }
                try {
                    mmAnalytics.event('begin_checkout', {
                        currency: data.currency || 'INR',
                        value: (data.amount || 0) / 100,
                        items: [{ item_id: productId, item_name: regionName, item_category: 'dp_7day' }]
                    });
                } catch (e) {}
                const rzp = new Razorpay(options);
                try {
                    rzp.on('payment.failed', function(resp) {
                        var err = (resp && resp.error) || {};
                        mmAnalytics.event('payment_failed', {
                            item_id: productId,
                            item_category: 'dp_7day',
                            code: String(err.code || '').slice(0, 60),
                            reason: String(err.reason || err.description || '').slice(0, 120)
                        });
                    });
                } catch (e) {}
                rzp.open();
            } catch (error) {
                loadingOverlay.classList.remove('open');
                console.error('Purchase error:', error);
                // Firebase JS SDK 8.x callable wraps HttpsError codes as
                // "functions/<code>" on the client — match both forms.
                var ecode = (error && error.code) || '';
                if (ecode === 'already-exists' || ecode === 'functions/already-exists') {
                    // Already purchased — unlock the region and close paywall
                    await fetchPurchaseStatus(true);
                    setMapMaxZoom(21);
                    enableMapInteraction();
                    document.getElementById('zoom-restrict-overlay').classList.remove('open');
                    showUnlockToast(regionName);
                } else {
                    alert('Payment error: ' + (error.message || error.code || JSON.stringify(error)));
                }
                updateStatus('Payment failed');
            }
        }

        // Subscribe to a weekly auto-renewing plan
        async function subscribeRegion(productId, regionName) {
            try {
                mmAnalytics.event('select_item', {
                    item_id: productId,
                    item_name: regionName,
                    item_category: 'subscription'
                });
            } catch (e) {}
            if (!currentUser || currentUser.isAnonymous) {
                pendingPurchase = { productId, regionName, purchaseType: 'subscription' };
                document.getElementById('auth-dialog-desc').textContent =
                    'Sign in with your Google account to subscribe to ' + regionName + '.';
                document.getElementById('auth-dialog-weblabel').style.display = 'block';
                document.getElementById('auth-dialog-overlay').classList.add('open');
                return;
            }

            // Silent-unlock if already active (one-time or subscription) — same
            // post-login resume case as buyRegion. hasPurchase covers both plan
            // types (see this function's own existing use at line below).
            if (hasPurchase(productId)) {
                document.getElementById('zoom-restrict-overlay').classList.remove('open');
                setMapMaxZoom(21);
                enableMapInteraction();
                showUnlockToast(regionName);
                try { await fetchCloudFrontCookies(); } catch (e) {}
                clearAllLayersOfType(dpOverlays);
                dpTileStatus = Array(dpLayerData.length).fill(false);
                loadTilesBasedOnViewport();
                lastCheckedRegionId = null;
                stickyTile = null;
                stickyDistrict = null;
                return;
            }

            var loadingOverlay = document.getElementById('payment-loading-overlay');
            var subUnit = (cachedSubPricing.get('default') || {}).periodUnit || 'week';
            var subUnitLabel = subUnit === 'day' ? 'Daily' : subUnit === 'week' ? 'Weekly' : subUnit === 'month' ? 'Monthly' : subUnit;
            document.getElementById('payment-loading-sub').textContent = subUnitLabel + ' Subscription: ' + regionName;
            loadingOverlay.classList.add('open');

            try {
                var createSubscription = functions.httpsCallable('createSubscription');
                var result = await createSubscription({ productId: productId, regionName: regionName });

                loadingOverlay.classList.remove('open');

                // Customer already has a halted/pending subscription for this
                // region — resume it by paying the outstanding invoice instead
                // of creating a duplicate. renewRegionSubscription opens the
                // Razorpay invoice checkout; subscription.charged reactivates
                // the SAME subscription.
                if (result.data && result.data.action === 'recover') {
                    return renewRegionSubscription(productId, regionName);
                }

                var subscriptionId = result.data.subscriptionId;

                // Poll for webhook confirmation — don't trust Razorpay UI result
                function pollForSubscriptionActivation(pid, subId, attempts, maxAttempts) {
                    if (attempts >= maxAttempts) {
                        loadingOverlay.classList.remove('open');
                        updateStatus('Subscription is being processed. Please refresh in a minute.');
                        return;
                    }
                    setTimeout(async function() {
                        await fetchPurchaseStatus(true);
                        if (hasPurchase(pid)) {
                            // Webhook confirmed — subscription is active
                            try {
                                mmAnalytics.event('purchase', {
                                    transaction_id: subId,
                                    currency: 'INR',
                                    items: [{ item_id: pid, item_name: regionName, item_category: 'subscription' }]
                                });
                                mmAnalytics.clarityTag('plan', 'paid');
                            } catch (e) {}
                            await fetchSubscriptionStatus();
                            // Refresh CloudFront cookies + mmp-token so the new
                            // subscription's productPurchaseID lands in the
                            // edge-verified claims cookie immediately — otherwise
                            // zoom 15+ tiles would 403 at the CF edge until the
                            // user refreshes the tab. Mirrors the one-time path
                            // at handler: callback above.
                            try { await fetchCloudFrontCookies(); } catch (e) { /* non-fatal; TTL refresh will catch up */ }
                            clearAllLayersOfType(dpOverlays);
                            dpTileStatus = Array(dpLayerData.length).fill(false);
                            loadTilesBasedOnViewport();
                            enableMapInteraction();
                            document.getElementById('zoom-restrict-overlay').classList.remove('open');
                            setMapMaxZoom(21);
                            lastCheckedRegionId = null;
                            stickyTile = null;
                            stickyDistrict = null;
                            loadingOverlay.classList.remove('open');
                            updateStatus('Subscription active!');
                        } else {
                            pollForSubscriptionActivation(pid, subId, attempts + 1, maxAttempts);
                        }
                    }, 3000); // poll every 3 seconds
                }

                var options = {
                    key: 'rzp_live_SXr1BKnoysSo9r',
                    subscription_id: subscriptionId,
                    name: 'Development Plans (GIS)',
                    description: 'Web only (not Android) — ' + subUnitLabel + ' Subscription: ' + regionName,
                    prefill: {
                        email: currentUser.email,
                        name: currentUser.displayName || ''
                    },
                    theme: { color: '#008577' },
                    handler: async function(response) {
                        // Payment went through Razorpay UI — show processing.
                        document.getElementById('payment-loading-text').textContent = 'Processing subscription...';
                        document.getElementById('payment-loading-sub').textContent = regionName;
                        loadingOverlay.classList.add('open');
                        updateStatus('Processing subscription...');
                        // Primary path: call confirmSubscription directly so
                        // access syncs even if the Razorpay webhook is delayed
                        // or rejected. The function is idempotent, so if the
                        // webhook already ran this is a cheap no-op.
                        try {
                            var confirmSub = functions.httpsCallable('confirmSubscription');
                            await confirmSub({ subscriptionId: subscriptionId, productId: productId });
                        } catch (e) {
                            // Expected when Razorpay hasn't flipped status to
                            // "active" yet (UPI AutoPay can lag a few seconds
                            // between authorization and first charge). Polling
                            // below waits for the webhook in that case.
                            console.warn('confirmSubscription fallback:', e && (e.message || e.code) || e);
                        }
                        pollForSubscriptionActivation(productId, subscriptionId, 0, 10);
                    },
                    modal: {
                        ondismiss: async function() {
                            // User closed Razorpay modal — payment may still have gone through.
                            document.getElementById('payment-loading-text').textContent = 'Checking payment status...';
                            document.getElementById('payment-loading-sub').textContent = regionName;
                            loadingOverlay.classList.add('open');
                            updateStatus('Checking payment status...');
                            try {
                                var confirmSub = functions.httpsCallable('confirmSubscription');
                                await confirmSub({ subscriptionId: subscriptionId, productId: productId });
                            } catch (e) {
                                console.warn('confirmSubscription (ondismiss) fallback:', e && (e.message || e.code) || e);
                            }
                            pollForSubscriptionActivation(productId, subscriptionId, 0, 5);
                        }
                    }
                };

                if (typeof Razorpay === 'undefined') {
                    await new Promise(function(resolve, reject) {
                        var s = document.createElement('script');
                        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
                        s.onload = resolve;
                        s.onerror = function() { reject(new Error('Could not load payment gateway.')); };
                        document.head.appendChild(s);
                    });
                }
                try {
                    mmAnalytics.event('begin_checkout', {
                        currency: 'INR',
                        items: [{ item_id: productId, item_name: regionName, item_category: 'subscription' }]
                    });
                } catch (e) {}
                var rzp = new Razorpay(options);
                try {
                    rzp.on('payment.failed', function(resp) {
                        var err = (resp && resp.error) || {};
                        mmAnalytics.event('payment_failed', {
                            item_id: productId,
                            item_category: 'subscription',
                            code: String(err.code || '').slice(0, 60),
                            reason: String(err.reason || err.description || '').slice(0, 120)
                        });
                    });
                } catch (e) {}
                rzp.open();
            } catch (error) {
                loadingOverlay.classList.remove('open');
                console.error('Subscription error:', error);
                var ecode = (error && error.code) || '';
                if (ecode === 'already-exists' || ecode === 'functions/already-exists') {
                    await fetchPurchaseStatus(true);
                    if (hasPurchase(productId)) {
                        setMapMaxZoom(21);
                        enableMapInteraction();
                        document.getElementById('zoom-restrict-overlay').classList.remove('open');
                        showUnlockToast(regionName);
                    }
                } else {
                    alert('Subscription error: ' + (error.message || error.code || JSON.stringify(error)));
                }
                updateStatus('');
            }
        }

        // Cancel a weekly subscription — show professional confirmation dialog
        function cancelRegionSubscription(productId, regionName) {
            var overlay = document.getElementById('cancel-sub-overlay');
            document.getElementById('cancel-sub-region').textContent = regionName;

            var accessLine = document.getElementById('cancel-sub-access-line');
            if (accessLine) {
                var sub = activeSubscriptions.get(productId);
                var purchase = activePurchases.get(productId);
                var accessUntil = (sub && sub.currentPeriodEnd) || (purchase && purchase.expiry) || 0;
                if (accessUntil) {
                    var dateStr = new Date(accessUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
                    accessLine.textContent = 'Your access will continue till ' + dateStr + ' even if cancelled';
                } else {
                    accessLine.textContent = 'Your access continues until the current period ends';
                }
            }

            // Replace buttons to remove old listeners
            var confirmBtn = document.getElementById('cancel-sub-confirm');
            var newConfirm = confirmBtn.cloneNode(true);
            newConfirm.id = 'cancel-sub-confirm';
            confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

            var keepBtn = document.getElementById('cancel-sub-keep');
            var newKeep = keepBtn.cloneNode(true);
            newKeep.id = 'cancel-sub-keep';
            keepBtn.parentNode.replaceChild(newKeep, keepBtn);

            newKeep.addEventListener('click', function() {
                overlay.classList.remove('open');
            });

            newConfirm.addEventListener('click', async function() {
                // Hide cancel dialog, show loading overlay
                overlay.classList.remove('open');
                var loadingOverlay = document.getElementById('payment-loading-overlay');
                document.getElementById('payment-loading-text').textContent = 'Cancelling subscription...';
                document.getElementById('payment-loading-sub').textContent = regionName;
                loadingOverlay.classList.add('open');
                try {
                    var cancel = functions.httpsCallable('cancelSubscription');
                    var result = await cancel({ productId: productId });
                    await fetchSubscriptionStatus();
                    loadingOverlay.classList.remove('open');
                    var accessUntil = result.data.accessUntil;
                    var dateStr = accessUntil ? new Date(accessUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'end of period';
                    renderSettingsPurchases();
                    updateStatus('Subscription cancelled — access until ' + dateStr);
                } catch (e) {
                    loadingOverlay.classList.remove('open');
                    console.error('Cancel subscription error:', e);
                    alert('Failed to cancel: ' + (e.message || e.code || 'Unknown error'));
                }
            });

            overlay.classList.add('open');
        }

        // Manual retry for a subscription in the 3-day grace window after an
        // Autopay charge failure. Fetches the open Razorpay invoice via a
        // server callable, then opens Razorpay Checkout against that invoice.
        // On success, the subscription.charged webhook clears grace and extends
        // the period; we just poll fetchSubscriptionStatus a couple of times.
        async function renewRegionSubscription(productId, regionName) {
            if (!currentUser || currentUser.isAnonymous) {
                alert('Please sign in to renew.');
                return;
            }
            var loadingOverlay = document.getElementById('payment-loading-overlay');
            document.getElementById('payment-loading-text').textContent = 'Preparing renewal...';
            document.getElementById('payment-loading-sub').textContent = regionName;
            loadingOverlay.classList.add('open');
            try {
                var getInvoice = functions.httpsCallable('getSubscriptionRenewInvoice');
                var result = await getInvoice({ productId: productId });
                var inv = result.data;
                if (!inv || !inv.invoiceId) {
                    loadingOverlay.classList.remove('open');
                    alert('Could not find a pending invoice to renew. Please refresh.');
                    return;
                }

                if (typeof Razorpay === 'undefined') {
                    await new Promise(function(resolve, reject) {
                        var s = document.createElement('script');
                        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
                        s.onload = resolve;
                        s.onerror = function() { reject(new Error('Could not load payment gateway.')); };
                        document.head.appendChild(s);
                    });
                }

                var options = {
                    key: 'rzp_live_SXr1BKnoysSo9r',
                    invoice_id: inv.invoiceId,
                    name: 'Development Plans (GIS)',
                    description: 'Web only (not Android) — Renew subscription: ' + regionName,
                    prefill: {
                        email: currentUser.email,
                        name: currentUser.displayName || ''
                    },
                    theme: { color: '#008577' },
                    handler: async function(response) {
                        document.getElementById('payment-loading-text').textContent = 'Confirming renewal...';
                        // Webhook flips status to active and clears grace flags.
                        setTimeout(function() {
                            fetchSubscriptionStatus().then(function() {
                                renderSettingsPurchases();
                                loadingOverlay.classList.remove('open');
                            });
                        }, 3000);
                        setTimeout(function() {
                            fetchSubscriptionStatus().then(renderSettingsPurchases);
                        }, 8000);
                    },
                    modal: {
                        ondismiss: function() {
                            // User closed the modal — payment may still have gone through.
                            setTimeout(function() {
                                fetchSubscriptionStatus().then(function() {
                                    renderSettingsPurchases();
                                    loadingOverlay.classList.remove('open');
                                });
                            }, 2000);
                        }
                    }
                };
                loadingOverlay.classList.remove('open');
                new Razorpay(options).open();
            } catch (e) {
                loadingOverlay.classList.remove('open');
                var msg = (e && (e.message || e.code)) || 'Could not start renewal.';
                alert('Renew failed: ' + msg);
                console.error('renewRegionSubscription:', e);
            }
        }

        // Debounce for checkFirebasePurchaseEntry — prevents rapid DB reads on zoom
        let _lastFirebaseCheckPid = null;
        let _lastFirebaseCheckTime = 0;

        // Global variables
        let map;
        let markers = [];
        let currentOpacity = 0.5;

        // Zoom restriction
        // Region detection now uses tile polygon boundaries from dpLayerData
        let zoomBypassActive = false; // true when programmatic zoom should skip restriction
        let mapInteractionDisabled = false;
        let lastRestrictedDistrict = null; // remember district for unlock button
        let lastCheckedRegionId = null; // cache to skip re-processing same region
        let lastToastedRegionId = null; // prevent repeated toasts when tiles oscillate
        let stickyTile = null;          // last detected tile — prevents false region switches during zoom
        let stickyDistrict = null;      // district result paired with stickyTile
        let lastRegionCenterLat = 0;   // center when region was last detected
        let lastRegionCenterLng = 0;   // used to distinguish zoom from pan
        let bannerDismissedForRegion = null; // track dismissed region to avoid re-showing
        let dialogTriggeredByRegionEntry = false; // distinguish region-entry vs zoom triggers
        const MAX_FREE_ZOOM = 14;

        // Guarded wrapper — avoids redundant map.setOptions({maxZoom}) calls during
        // continuous wheel/pinch zoom. Each setOptions triggers a sync map state
        // recompile, so calling it 30x per gesture with the same value causes jank.
        let _currentMaxZoom = null;
        function setMapMaxZoom(z) {
            if (_currentMaxZoom === z) return;
            _currentMaxZoom = z;
            map.setOptions({ maxZoom: z });
        }

        // Guards for the locked-region zoom_changed branch. Previously each zoom tick
        // queued a fresh addListenerOnce('idle',...) and re-scanned all district
        // polygons; a 30-tick gesture queued 30 handlers that all fired at gesture end.
        let _pendingLockedIdle = false;

        // Village-boundary geojson (ported from Android pipeline)
        const MIN_ZOOM_FOR_GEOJSON = 12;
        // CloudFront-hosted zips. Folder name is an upload-pipeline marker,
        // not a file-format hint — contents are still .zip, unzipped client-side.
        // Served through signed cookies — same auth as tiles.
        const GEOJSON_BASE_PATH = `https://${TILE_HOST}/dpplans/0geojson_dontUnzip/`;
        const GEOJSON_MAX_CONCURRENT_DOWNLOADS = 3;

        // Solapur decorative overlay (labels, TP scheme dashed polygons, archaeological
        // magenta buffer lines) — ported from Android Constants.kt. Quadratic ease-out
        // fade: drops fast right after z12 so labels get out of the way for the overview,
        // then slows asymptotically to a near-invisible floor at z16. Fully hidden at
        // z17 and above so high-zoom DP tile detail isn't obscured.
        //   z ≤ 12          → 100% opaque
        //   z 12 → 17       → ease-out 1.00 → ~0.18 (steep early, gentle late)
        //   z ≥ 17          → hidden
        const SOLAPUR_FADE_MIN_ZOOM = 12;   // at/below this zoom labels are fully opaque
        const SOLAPUR_HIDE_ZOOM     = 17;   // at/above this zoom labels are hidden
        const SOLAPUR_HIDE_OPACITY  = 0.15; // floor opacity that the ease-out approaches

        // Low-memory device gate — skip heavy GeoJSON + Solapur overlays on < 8 GB devices.
        // navigator.deviceMemory is Chrome/Edge/Opera/Samsung Internet (covers most
        // Android traffic). Returns GiB rounded to nearest power-of-two bucket
        // (0.25, 0.5, 1, 2, 4, 8). Undefined on Firefox/Safari → treated as capable.
        const IS_LOW_MEMORY_DEVICE = (navigator.deviceMemory || 8) < 8;
        let isVillageBoundaryEnabled = !IS_LOW_MEMORY_DEVICE;

        // ---------- District bounds index (Firebase-backed, localStorage-cached) ----------
        // Source of truth is Firebase RTDB node `districtBboxes`, populated by the
        // districtBboxPublisher AWS Lambda whenever a zip is uploaded/deleted to
        // s3://www.mapdata.com/dpplans/0geojson_dontUnzip/. Cached in localStorage
        // (`layer_district_bbox`) using the same version-gated pattern as DP plan;
        // Lambda bumps `appConfig/dataVersions/layer_district_bbox` on every change
        // so cached web users invalidate within one page-load cycle.
        //
        // Kept as `let` so the synchronous localStorage seed populates entries
        // before the first viewport check on warm-cache loads. On cold cache
        // the array starts empty; first call to _doLoadGeoJsonForViewport awaits
        // loadDistrictBboxIndex() to guarantee data before iterating.
        const DISTRICT_BBOX_CACHE_KEY = 'layer_district_bbox';
        const DISTRICT_BBOX_VERSION_KEY = 'layer_district_bbox';
        let GEOJSON_DISTRICT_INDEX = [];
        let _districtBboxLoadPromise = null;

        (function _seedDistrictBboxFromCache() {
            try {
                const raw = localStorage.getItem(DISTRICT_BBOX_CACHE_KEY);
                if (!raw) return;
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.d)) GEOJSON_DISTRICT_INDEX = parsed.d;
            } catch (e) { /* ignore */ }
        })();

        function loadDistrictBboxIndex() {
            if (_districtBboxLoadPromise) return _districtBboxLoadPromise;
            _districtBboxLoadPromise = (async function() {
                let cached = null;
                try {
                    const raw = localStorage.getItem(DISTRICT_BBOX_CACHE_KEY);
                    if (raw) cached = JSON.parse(raw);
                } catch (e) { /* ignore */ }

                let liveVersion = null;
                try {
                    liveVersion = await firebase.database()
                        .ref('appConfig/dataVersions/' + DISTRICT_BBOX_VERSION_KEY)
                        .once('value')
                        .then(function(s) { return s.val(); });
                } catch (e) {
                    // Network/Firebase issue. If we have a cached array, keep it.
                    console.warn('[districtBbox] version read failed:', e && e.message);
                    if (cached && Array.isArray(cached.d)) return GEOJSON_DISTRICT_INDEX;
                }

                const cachedVersion = cached ? cached.v : null;
                if (cached && Array.isArray(cached.d) && cached.d.length > 0
                    && liveVersion === cachedVersion) {
                    return GEOJSON_DISTRICT_INDEX;
                }

                // Cold cache OR stale OR empty: read full bbox node from Firebase.
                const snap = await firebase.database().ref('districtBboxes').once('value');
                const fresh = [];
                snap.forEach(function(child) {
                    const v = child.val();
                    const b = v && v.bbox;
                    if (!b || typeof b.north !== 'number') return;
                    const fileName = v.fileName || (child.key + '.zip');
                    fresh.push({
                        name: v.name || child.key,
                        file: fileName.replace(/\.zip$/i, ''),
                        n: b.north, s: b.south, e: b.east, w: b.west,
                    });
                });

                GEOJSON_DISTRICT_INDEX = fresh;
                try {
                    localStorage.setItem(DISTRICT_BBOX_CACHE_KEY, JSON.stringify({
                        v: liveVersion === undefined ? null : liveVersion,
                        d: fresh,
                    }));
                } catch (e) { /* quota — fine */ }
                return fresh;
            })();
            return _districtBboxLoadPromise;
        }

        // Kick off the network revalidation in the background. Synchronous seed
        // above already populated GEOJSON_DISTRICT_INDEX from cache for warm
        // loads; this resolves the cold-cache case before the first viewport
        // intersection runs (also enforced by an await in _doLoadGeoJsonForViewport).
        loadDistrictBboxIndex();
        // 15-color palette — high contrast, no greys/white/black. Fully opaque so
        // boundaries stay visible on satellite + busy basemaps; prior 0.39 alpha
        // washed out against dense imagery.
        const GEOJSON_DISTRICT_COLORS = [
            'rgba(0,0,255,1)',        'rgba(255,0,0,1)',        'rgba(0,128,0,1)',
            'rgba(255,165,0,1)',      'rgba(128,0,128,1)',      'rgba(255,0,255,1)',
            'rgba(0,255,255,1)',      'rgba(255,255,0,1)',      'rgba(165,42,42,1)',
            'rgba(0,100,0,1)',        'rgba(255,20,147,1)',     'rgba(0,0,139,1)',
            'rgba(255,69,0,1)',       'rgba(75,0,130,1)',       'rgba(0,191,255,1)'
        ];
        let _nextDistrictColorIndex = 0;

        // ===== Measurement State =====
        let measureMode = null;           // null | 'length' | 'area'
        let measurePoints = [];           // Array of {lat, lng}
        let measureMarkers = [];          // google.maps.Marker for vertex dots
        let measurePolyline = null;       // google.maps.Polyline (length mode)
        let measurePolygon = null;        // google.maps.Polygon (area mode)
        let measureLabels = [];           // MeasureLabelOverlay instances
        let measureClickListener = null;  // google.maps.MapsEventListener
        let savedMeasurements = [];       // Persisted measurement objects
        let savedMeasureOverlays = [];    // {id, shapes:[], markers:[], labels:[]}
        let selectedMeasureId = null;     // Currently selected saved measurement
        let measureDeleteIW = null;       // InfoWindow for delete button
        let MeasureLabelOverlay = null;   // Class, assigned in initMap after API loads
        let VertexHandleOverlay = null;   // Class, assigned in initMap after API loads
        let activeVertexHandle = null;    // Current visible vertex handle overlay
        let magnifierMap = null;          // Secondary map for magnifier loupe
        let magnifierVisible = false;
        let projHelper = null;            // OverlayView for lat/lng → screen pixel conversion

        function showMagnifier(latLng) {
            if (!magnifierMap) {
                magnifierMap = new google.maps.Map(document.getElementById('magnifier-map'), {
                    center: latLng,
                    zoom: Math.min(map.getZoom() + 3, 21),
                    mapTypeId: map.getMapTypeId(),
                    disableDefaultUI: true,
                    gestureHandling: 'none',
                    keyboardShortcuts: false
                });
            }
            magnifierMap.setMapTypeId(map.getMapTypeId());
            magnifierMap.setZoom(Math.min(map.getZoom() + 3, 21));
            magnifierMap.setCenter(latLng);
            document.getElementById('magnifier').style.display = 'block';
            magnifierVisible = true;
            positionMagnifier(latLng);
        }

        function moveMagnifier(latLng) {
            if (!magnifierVisible || !magnifierMap) return;
            magnifierMap.setCenter(latLng);
            positionMagnifier(latLng);
        }

        function positionMagnifier(latLng) {
            if (!projHelper || !projHelper.getProjection()) return;
            const containerPx = projHelper.getProjection().fromLatLngToContainerPixel(latLng);
            if (!containerPx) return;
            const mapRect = map.getDiv().getBoundingClientRect();
            const sx = mapRect.left + containerPx.x;
            const sy = mapRect.top + containerPx.y;
            const mag = document.getElementById('magnifier');
            const magW = 120;
            // Position above the touch point; if too close to top, show below
            let top = sy - magW - 30;
            if (top < 0) top = sy + 30;
            mag.style.left = (sx - magW / 2) + 'px';
            mag.style.top = top + 'px';
        }

        function hideMagnifier() {
            document.getElementById('magnifier').style.display = 'none';
            magnifierVisible = false;
        }

        // Haversine distance in meters
        function haversineDistance(p1, p2) {
            const R = 6371000;
            const dLat = (p2.lat - p1.lat) * Math.PI / 180;
            const dLng = (p2.lng - p1.lng) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                      Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
                      Math.sin(dLng / 2) * Math.sin(dLng / 2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }

        // Spherical polygon area in square meters
        function sphericalPolygonArea(points) {
            const R = 6371000;
            const rad = Math.PI / 180;
            const n = points.length;
            if (n < 3) return 0;
            let sum = 0;
            for (let i = 0; i < n; i++) {
                const p1 = points[i];
                const p2 = points[(i + 1) % n];
                sum += (p2.lng - p1.lng) * rad *
                       (2 + Math.sin(p1.lat * rad) + Math.sin(p2.lat * rad));
            }
            return Math.abs(sum * R * R / 2);
        }

        function formatDistance(meters, unit) {
            switch (unit) {
                case 'ft': return (meters * 3.28084).toFixed(1) + ' ft';
                case 'km': return (meters / 1000).toFixed(3) + ' km';
                default:   return meters.toFixed(1) + ' m';
            }
        }

        function formatArea(sqMeters, unit) {
            switch (unit) {
                case 'hectare': return (sqMeters / 10000).toFixed(3) + ' ha';
                case 'acre':    return (sqMeters / 4046.856).toFixed(3) + ' ac';
                default:        return sqMeters.toFixed(1) + ' sq m';
            }
        }

        function getTotalDistance(points) {
            let total = 0;
            for (let i = 0; i < points.length - 1; i++) {
                total += haversineDistance(points[i], points[i + 1]);
            }
            return total;
        }

        function getMidpoint(p1, p2) {
            return { lat: (p1.lat + p2.lat) / 2, lng: (p1.lng + p2.lng) / 2 };
        }

        // ===== Vertex Handle (move + delete popup) =====

        function showVertexHandle(marker, callbacks) {
            // callbacks: { onMove(latLng), onMoveEnd(), onDelete() }
            hideVertexHandle();
            activeVertexHandle = new VertexHandleOverlay(marker, callbacks, map);
            // Highlight the vertex
            marker.setIcon({
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10, fillColor: '#FF5722', fillOpacity: 1,
                strokeColor: '#fff', strokeWeight: 3
            });
            activeVertexHandle._origIcon = marker.getIcon();
        }

        function hideVertexHandle() {
            if (!activeVertexHandle) return;
            // Restore vertex icon
            const m = activeVertexHandle._marker;
            if (m && m.getMap()) {
                const isSaved = activeVertexHandle._isSaved;
                const color = isSaved ? '#008577' : '#FF6D00';
                m.setIcon({
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: isSaved ? 7 : 8, fillColor: color, fillOpacity: 1,
                    strokeColor: '#fff', strokeWeight: 2
                });
            }
            activeVertexHandle.setMap(null);
            activeVertexHandle = null;
        }

        function deleteInProgressVertex(idx) {
            hideVertexHandle();
            if (measurePoints.length <= 1) {
                // If only 1 point, just remove it
                measurePoints.splice(idx, 1);
                const removed = measureMarkers.splice(idx, 1);
                removed.forEach(m => m.setMap(null));
            } else {
                measurePoints.splice(idx, 1);
                const removed = measureMarkers.splice(idx, 1);
                removed.forEach(m => m.setMap(null));
            }
            // Reindex remaining markers
            measureMarkers.forEach(function(m, i) { m._ptIndex = i; });
            updateMeasureVisuals();
        }

        function deleteSavedVertex(measId, idx) {
            hideVertexHandle();
            const m = savedMeasurements.find(function(x) { return x.id === measId; });
            if (!m) return;
            const minPts = m.type === 'area' ? 3 : 2;
            if (m.points.length <= minPts) {
                // Too few points — delete entire measurement
                deleteMeasurement(measId);
                return;
            }
            m.points.splice(idx, 1);
            // Remove old overlays and re-render
            const ov = savedMeasureOverlays.find(function(o) { return o.id === measId; });
            if (ov) {
                ov.shapes.forEach(function(s) { s.setMap(null); });
                ov.markers.forEach(function(mk) { mk.setMap(null); });
                ov.labels.forEach(function(l) { l.setMap(null); });
            }
            savedMeasureOverlays = savedMeasureOverlays.filter(function(o) { return o.id !== measId; });
            renderSavedMeasurement(m);
            try {
                localStorage.setItem('gis_measurements', JSON.stringify(savedMeasurements));
            } catch (e) { /* ignore */ }
            updateStatus('Vertex removed');
        }

        // ===== Core Measurement Functions =====

        function startMeasureMode(mode) {
            if (measureMode) stopMeasureMode(false);
            hideVertexHandle();
            deselectMeasurement();
            measureMode = mode;
            measurePoints = [];
            measureMarkers = [];
            measureLabels = [];
            measurePolyline = null;
            measurePolygon = null;

            // Activate pill button
            document.getElementById('btn-measure-length').classList.toggle('active', mode === 'length');
            document.getElementById('btn-measure-area').classList.toggle('active', mode === 'area');

            // Show toolbar
            document.getElementById('measure-toolbar').classList.add('active');
            document.getElementById('measure-info').classList.add('active');
            document.getElementById('measure-info').textContent = mode === 'length' ? '0 m' : '0 sq m';
            document.getElementById('measure-status').textContent = 'Tap to place points';
            document.getElementById('measure-done').disabled = true;

            // Show correct unit selector
            document.getElementById('measure-unit-length').style.display = mode === 'length' ? '' : 'none';
            document.getElementById('measure-unit-area').style.display = mode === 'area' ? '' : 'none';

            // Map interaction
            map.setOptions({ disableDoubleClickZoom: true, draggableCursor: 'crosshair' });
            measureClickListener = map.addListener('click', onMeasureClick);
        }

        function onMeasureClick(event) {
            const pt = { lat: event.latLng.lat(), lng: event.latLng.lng() };
            measurePoints.push(pt);
            const idx = measurePoints.length - 1;

            // Create vertex marker (draggable + tap to show handle)
            const marker = new google.maps.Marker({
                position: event.latLng,
                map: map,
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 8, fillColor: '#FF6D00', fillOpacity: 1,
                    strokeColor: '#fff', strokeWeight: 2
                },
                zIndex: 1000, clickable: true, draggable: true
            });
            marker._ptIndex = idx;
            marker.addListener('dragstart', function() {
                showMagnifier(marker.getPosition());
            });
            marker.addListener('drag', function() {
                measurePoints[marker._ptIndex] = { lat: marker.getPosition().lat(), lng: marker.getPosition().lng() };
                updateMeasureVisuals();
                moveMagnifier(marker.getPosition());
                if (activeVertexHandle && activeVertexHandle._marker === marker) activeVertexHandle.draw();
            });
            marker.addListener('dragend', function() {
                hideMagnifier();
            });
            marker.addListener('click', function() {
                showVertexHandle(marker, {
                    isSaved: false,
                    onMove: function(latLng) {
                        measurePoints[marker._ptIndex] = { lat: latLng.lat(), lng: latLng.lng() };
                        updateMeasureVisuals();
                    },
                    onMoveEnd: function() {},
                    onDelete: function() {
                        deleteInProgressVertex(marker._ptIndex);
                    }
                });
            });
            measureMarkers.push(marker);
            updateMeasureVisuals();
        }

        function updateMeasureVisuals() {
            const pts = measurePoints;
            const isArea = measureMode === 'area';
            const unitEl = isArea
                ? document.getElementById('measure-unit-area')
                : document.getElementById('measure-unit-length');
            const unit = unitEl.value;

            // Remove old polyline/polygon
            if (measurePolyline) { measurePolyline.setMap(null); measurePolyline = null; }
            if (measurePolygon) { measurePolygon.setMap(null); measurePolygon = null; }

            // Remove old labels
            measureLabels.forEach(l => l.setMap(null));
            measureLabels = [];

            if (pts.length >= 2) {
                const path = pts.map(p => ({ lat: p.lat, lng: p.lng }));

                if (isArea && pts.length >= 3) {
                    measurePolygon = new google.maps.Polygon({
                        paths: path, map: map,
                        strokeColor: '#FF6D00', strokeOpacity: 1, strokeWeight: 3,
                        fillColor: '#FF6D00', fillOpacity: 0.15, zIndex: 999, clickable: false
                    });
                } else {
                    measurePolyline = new google.maps.Polyline({
                        path: path, map: map,
                        strokeColor: '#FF6D00', strokeOpacity: 1, strokeWeight: 3,
                        zIndex: 999, clickable: false
                    });
                }

                // Segment labels
                const segCount = isArea && pts.length >= 3 ? pts.length : pts.length - 1;
                for (let i = 0; i < segCount; i++) {
                    const p1 = pts[i];
                    const p2 = pts[(i + 1) % pts.length];
                    const dist = haversineDistance(p1, p2);
                    const mid = getMidpoint(p1, p2);
                    const text = isArea ? formatDistance(dist, 'm') : formatDistance(dist, unit);
                    const lbl = new MeasureLabelOverlay(
                        new google.maps.LatLng(mid.lat, mid.lng), text, map
                    );
                    measureLabels.push(lbl);
                }
            }

            // Update info display
            const infoEl = document.getElementById('measure-info');
            if (isArea) {
                if (pts.length >= 3) {
                    infoEl.textContent = formatArea(sphericalPolygonArea(pts), unit);
                } else {
                    infoEl.textContent = '0 sq m';
                }
            } else {
                infoEl.textContent = formatDistance(getTotalDistance(pts), unit);
            }

            // Update status text
            const statusEl = document.getElementById('measure-status');
            if (pts.length === 0) statusEl.textContent = 'Tap to place points';
            else if (pts.length === 1) statusEl.textContent = 'Tap next point';
            else statusEl.textContent = pts.length + ' points';

            // Enable/disable done button
            const minPts = isArea ? 3 : 2;
            document.getElementById('measure-done').disabled = pts.length < minPts;
        }

        function clearMeasureOverlays() {
            measureMarkers.forEach(m => m.setMap(null));
            measureMarkers = [];
            if (measurePolyline) { measurePolyline.setMap(null); measurePolyline = null; }
            if (measurePolygon) { measurePolygon.setMap(null); measurePolygon = null; }
            measureLabels.forEach(l => l.setMap(null));
            measureLabels = [];
        }

        function stopMeasureMode(save) {
            if (!measureMode) return;
            hideVertexHandle();

            // Remove click listener
            if (measureClickListener) {
                google.maps.event.removeListener(measureClickListener);
                measureClickListener = null;
            }

            // Save if requested
            if (save) {
                const minPts = measureMode === 'area' ? 3 : 2;
                if (measurePoints.length >= minPts) {
                    saveMeasurement();
                }
            }

            // Clear in-progress overlays
            clearMeasureOverlays();

            // Reset map options
            map.setOptions({ disableDoubleClickZoom: false, draggableCursor: null });

            // Hide UI
            document.getElementById('measure-toolbar').classList.remove('active');
            document.getElementById('measure-info').classList.remove('active');
            document.getElementById('btn-measure-length').classList.remove('active');
            document.getElementById('btn-measure-area').classList.remove('active');

            measureMode = null;
            measurePoints = [];
        }

        // ===== Persistence =====

        function saveMeasurement() {
            const unitEl = measureMode === 'area'
                ? document.getElementById('measure-unit-area')
                : document.getElementById('measure-unit-length');
            const m = {
                id: Date.now(),
                type: measureMode,
                points: measurePoints.map(p => ({ lat: p.lat, lng: p.lng })),
                unit: unitEl.value
            };
            savedMeasurements.push(m);
            try {
                localStorage.setItem('gis_measurements', JSON.stringify(savedMeasurements));
            } catch (e) { /* localStorage full */ }
            renderSavedMeasurement(m);
            updateClearMeasurementsButton();
            updateStatus('Measurement saved');
        }

        function loadSavedMeasurements() {
            try {
                const json = localStorage.getItem('gis_measurements');
                if (!json) return;
                savedMeasurements = JSON.parse(json);
                savedMeasurements.forEach(m => renderSavedMeasurement(m));
            } catch (e) {
                savedMeasurements = [];
            }
            updateClearMeasurementsButton();
        }

        function renderSavedMeasurement(m) {
            const color = '#008577';
            const overlays = { id: m.id, shapes: [], markers: [], labels: [] };

            // Build shapes and labels
            rebuildSavedShapesAndLabels(m, overlays, color);

            // Vertex markers (draggable + tap to show move handle + delete)
            m.points.forEach(function(p, idx) {
                const marker = new google.maps.Marker({
                    position: { lat: p.lat, lng: p.lng }, map: map,
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 7, fillColor: color, fillOpacity: 1,
                        strokeColor: '#fff', strokeWeight: 2
                    },
                    zIndex: 1000, clickable: true, draggable: true, cursor: 'grab'
                });
                marker._ptIndex = idx;
                marker._measId = m.id;
                marker.addListener('dragstart', function() {
                    showMagnifier(marker.getPosition());
                });
                marker.addListener('drag', function() {
                    m.points[idx] = { lat: marker.getPosition().lat(), lng: marker.getPosition().lng() };
                    overlays.shapes.forEach(function(s) { s.setMap(null); });
                    overlays.labels.forEach(function(l) { l.setMap(null); });
                    overlays.shapes = [];
                    overlays.labels = [];
                    rebuildSavedShapesAndLabels(m, overlays, color);
                    moveMagnifier(marker.getPosition());
                    if (activeVertexHandle && activeVertexHandle._marker === marker) activeVertexHandle.draw();
                });
                marker.addListener('dragend', function() {
                    hideMagnifier();
                    try {
                        localStorage.setItem('gis_measurements', JSON.stringify(savedMeasurements));
                    } catch (e) { /* ignore */ }
                });
                marker.addListener('click', function() {
                    showVertexHandle(marker, {
                        isSaved: true,
                        onMove: function(latLng) {
                            m.points[idx] = { lat: latLng.lat(), lng: latLng.lng() };
                            overlays.shapes.forEach(function(s) { s.setMap(null); });
                            overlays.labels.forEach(function(l) { l.setMap(null); });
                            overlays.shapes = [];
                            overlays.labels = [];
                            rebuildSavedShapesAndLabels(m, overlays, color);
                        },
                        onMoveEnd: function() {
                            try {
                                localStorage.setItem('gis_measurements', JSON.stringify(savedMeasurements));
                            } catch (e) { /* ignore */ }
                        },
                        onDelete: function() {
                            deleteSavedVertex(m.id, idx);
                        }
                    });
                });
                overlays.markers.push(marker);
            });

            savedMeasureOverlays.push(overlays);
        }

        function rebuildSavedShapesAndLabels(m, overlays, color) {
            const path = m.points.map(p => ({ lat: p.lat, lng: p.lng }));

            if (m.type === 'area' && m.points.length >= 3) {
                const polygon = new google.maps.Polygon({
                    paths: path, map: map,
                    strokeColor: color, strokeOpacity: 1, strokeWeight: 3,
                    fillColor: color, fillOpacity: 0.15, zIndex: 998, clickable: true
                });
                polygon.addListener('click', function(e) { selectMeasurement(m.id, e.latLng); });
                overlays.shapes.push(polygon);

                // Segment labels for all edges
                for (let i = 0; i < m.points.length; i++) {
                    const p1 = m.points[i];
                    const p2 = m.points[(i + 1) % m.points.length];
                    const dist = haversineDistance(p1, p2);
                    const mid = getMidpoint(p1, p2);
                    const lbl = new MeasureLabelOverlay(
                        new google.maps.LatLng(mid.lat, mid.lng),
                        formatDistance(dist, 'm'), map
                    );
                    overlays.labels.push(lbl);
                }

                // Area label at centroid
                const centroid = { lat: 0, lng: 0 };
                m.points.forEach(p => { centroid.lat += p.lat; centroid.lng += p.lng; });
                centroid.lat /= m.points.length;
                centroid.lng /= m.points.length;
                const areaLabel = new MeasureLabelOverlay(
                    new google.maps.LatLng(centroid.lat, centroid.lng),
                    formatArea(sphericalPolygonArea(m.points), m.unit), map
                );
                overlays.labels.push(areaLabel);
            } else if (m.type === 'length' && m.points.length >= 2) {
                const polyline = new google.maps.Polyline({
                    path: path, map: map,
                    strokeColor: color, strokeOpacity: 1, strokeWeight: 3,
                    zIndex: 998, clickable: true
                });
                polyline.addListener('click', function(e) { selectMeasurement(m.id, e.latLng); });
                overlays.shapes.push(polyline);

                // Segment labels
                for (let i = 0; i < m.points.length - 1; i++) {
                    const p1 = m.points[i];
                    const p2 = m.points[i + 1];
                    const dist = haversineDistance(p1, p2);
                    const mid = getMidpoint(p1, p2);
                    const lbl = new MeasureLabelOverlay(
                        new google.maps.LatLng(mid.lat, mid.lng),
                        formatDistance(dist, m.unit), map
                    );
                    overlays.labels.push(lbl);
                }

                // Total distance label at last point
                const totalDist = getTotalDistance(m.points);
                const lastPt = m.points[m.points.length - 1];
                const totalLabel = new MeasureLabelOverlay(
                    new google.maps.LatLng(lastPt.lat, lastPt.lng),
                    'Total: ' + formatDistance(totalDist, m.unit), map
                );
                overlays.labels.push(totalLabel);
            }
        }

        function selectMeasurement(id, latLng) {
            // If already selected, deselect
            if (selectedMeasureId === id) { deselectMeasurement(); return; }
            deselectMeasurement();
            selectedMeasureId = id;

            // Highlight the shape
            const ov = savedMeasureOverlays.find(o => o.id === id);
            if (ov) {
                ov.shapes.forEach(s => s.setOptions({ strokeWeight: 6 }));
            }

            // Show delete InfoWindow
            if (measureDeleteIW) measureDeleteIW.close();
            measureDeleteIW = new google.maps.InfoWindow({
                content: '<button id="meas-del-btn" style="background:#f44336;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600;">Delete</button>',
                position: latLng, disableAutoPan: true
            });
            measureDeleteIW.open(map);
            google.maps.event.addListenerOnce(measureDeleteIW, 'domready', function() {
                document.getElementById('meas-del-btn').addEventListener('click', function() {
                    deleteMeasurement(id);
                });
            });
            google.maps.event.addListenerOnce(measureDeleteIW, 'closeclick', function() {
                deselectMeasurement();
            });
        }

        function deselectMeasurement() {
            if (selectedMeasureId !== null) {
                const ov = savedMeasureOverlays.find(o => o.id === selectedMeasureId);
                if (ov) ov.shapes.forEach(s => s.setOptions({ strokeWeight: 3 }));
            }
            selectedMeasureId = null;
            if (measureDeleteIW) { measureDeleteIW.close(); measureDeleteIW = null; }
        }

        function deleteMeasurement(id) {
            // Remove overlays from map
            const ov = savedMeasureOverlays.find(o => o.id === id);
            if (ov) {
                ov.shapes.forEach(s => s.setMap(null));
                ov.markers.forEach(m => m.setMap(null));
                ov.labels.forEach(l => l.setMap(null));
            }
            savedMeasureOverlays = savedMeasureOverlays.filter(o => o.id !== id);
            savedMeasurements = savedMeasurements.filter(m => m.id !== id);
            try {
                localStorage.setItem('gis_measurements', JSON.stringify(savedMeasurements));
            } catch (e) { /* ignore */ }
            deselectMeasurement();
            updateClearMeasurementsButton();
            updateStatus('Measurement deleted');
        }

        function clearMeasurementsByType(type) {
            deselectMeasurement();
            hideVertexHandle();
            var idsToRemove = new Set();
            savedMeasurements.forEach(function(m) { if (m.type === type) idsToRemove.add(m.id); });
            savedMeasureOverlays.forEach(function(ov) {
                if (!idsToRemove.has(ov.id)) return;
                ov.shapes.forEach(function(s) { s.setMap(null); });
                ov.markers.forEach(function(m) { m.setMap(null); });
                ov.labels.forEach(function(l) { l.setMap(null); });
            });
            savedMeasureOverlays = savedMeasureOverlays.filter(function(ov) { return !idsToRemove.has(ov.id); });
            savedMeasurements = savedMeasurements.filter(function(m) { return m.type !== type; });
            try {
                if (savedMeasurements.length > 0) {
                    localStorage.setItem('gis_measurements', JSON.stringify(savedMeasurements));
                } else {
                    localStorage.removeItem('gis_measurements');
                }
            } catch (e) {}
            updateClearMeasurementsButton();
        }

        function updateClearMeasurementsButton() {
            var hasArea = savedMeasurements.some(function(m) { return m.type === 'area'; });
            var hasLength = savedMeasurements.some(function(m) { return m.type === 'length'; });
            var ax = document.getElementById('clear-area-x');
            var lx = document.getElementById('clear-length-x');
            if (ax) ax.style.display = hasArea ? 'inline-block' : 'none';
            if (lx) lx.style.display = hasLength ? 'inline-block' : 'none';
        }

        // Point-in-polygon test (ray casting) — used on main thread for region detection
        function pointInPolygon(point, polygon) {
            let inside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const xi = polygon[i].lng, yi = polygon[i].lat;
                const xj = polygon[j].lng, yj = polygon[j].lat;
                const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
                    (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
                if (intersect) inside = !inside;
            }
            return inside;
        }

        function findVillageAtCenter() {
            if (!map || !isVillageLayerVisible || villageLayerData.length === 0) return null;
            var c = map.getCenter();
            var center = { lat: c.lat(), lng: c.lng() };
            for (var i = 0; i < villageLayerData.length; i++) {
                var item = villageLayerData[i];
                if (!item.polygon) continue;
                // Bbox prefilter — cheap reject for the ~99% of villages the center
                // isn't inside. pointInPolygon over ~400 village rings was the
                // dominant main-thread cost during fast zoom/pan gestures.
                var b = item.bbox;
                if (b && (center.lat < b.minLat || center.lat > b.maxLat ||
                          center.lng < b.minLng || center.lng > b.maxLng)) continue;
                if (pointInPolygon(center, item.polygon)) return item;
            }
            return null;
        }

        // Gesture-level memoization — mirrors findDistrictAtCenterCached. Zoom
        // and pan listeners call findVillageAtCenter multiple times per tick;
        // cache by center+zoom rounded to ~10 m so real pans invalidate fast.
        let _villageCache = { key: null, value: null };
        function findVillageAtCenterCached() {
            if (!map) return null;
            const c = map.getCenter();
            const key = c.lat().toFixed(4) + ',' + c.lng().toFixed(4) + '@' + map.getZoom();
            if (_villageCache.key === key) return _villageCache.value;
            const v = findVillageAtCenter();
            _villageCache = { key: key, value: v };
            return v;
        }

        // PERF (maps10 fix #2): merged dpLayerData entries store a 4-corner
        // rectangle as their .polygon (covering the union bbox of all
        // sub-sheets), which is too permissive for the main-thread
        // "which region am I in?" check. This helper looks at the actual
        // sub-sheet polygons for merged entries and returns both the
        // inside-flag and the SMALLEST matching sub-sheet's bbox area for
        // tie-breaking. Un-merged entries are unchanged.
        function _checkLayerEntryAtPoint(entry, point) {
            if (!entry || !entry.polygon) return { inside: false, area: Infinity };
            if (!entry.isMerged) {
                if (!pointInPolygon(point, entry.polygon)) return { inside: false, area: Infinity };
                var bb = entry.bbox;
                var area = bb ? (bb.maxLat - bb.minLat) * (bb.maxLng - bb.minLng) : Infinity;
                return { inside: true, area: area };
            }
            // Merged: walk sub-sheets, find the smallest one whose REAL
            // polygon contains the point. The merged rectangle is ignored.
            if (!entry.subSheets) return { inside: false, area: Infinity };
            var bestArea = Infinity;
            for (var i = 0; i < entry.subSheets.length; i++) {
                var sub = entry.subSheets[i];
                if (!sub.polygon) continue;
                var sb = sub.bbox;
                if (sb && (point.lat < sb.minLat || point.lat > sb.maxLat ||
                           point.lng < sb.minLng || point.lng > sb.maxLng)) continue;
                if (!pointInPolygon(point, sub.polygon)) continue;
                var sba = sb ? (sb.maxLat - sb.minLat) * (sb.maxLng - sb.minLng) : Infinity;
                if (sba < bestArea) bestArea = sba;
            }
            return { inside: bestArea !== Infinity, area: bestArea };
        }

        // Phase 1: returns an array of candidate indices into `layerArray`
        // for `point`. With a Flatbush index registered via _buildLayerIndex,
        // this returns only entries whose bbox contains the point — typically
        // <10 hits out of 100–500 entries. Without the index, returns the
        // full range so the caller's behavior is unchanged.
        function _candidateIndicesAtPoint(layerArray, point) {
            if (!layerArray || layerArray.length === 0) return [];
            var meta = _layerIndexMeta.get(layerArray);
            if (meta) {
                var hits = meta.index.search(point.lng, point.lat, point.lng, point.lat);
                var map = meta.idxMap;
                var out = new Array(hits.length);
                for (var j = 0; j < hits.length; j++) out[j] = map[hits[j]];
                return out;
            }
            var all = new Array(layerArray.length);
            for (var i = 0; i < layerArray.length; i++) all[i] = i;
            return all;
        }

        function findDistrictAtCenter() {
            if (!map) return null;
            const c = map.getCenter();
            const center = { lat: c.lat(), lng: c.lng() };

            // Use tile polygon boundaries from dpLayerData, then look up district name via menuGIS
            // When multiple tiles overlap at boundaries, prefer the smallest (most specific) tile
            if (dpLayerData.length > 0) {
                // Seed with sticky tile (if it still contains center) to prevent
                // false switches to LARGER polygons during zoom drift.
                // Smaller (more specific) polygons will still override below.
                let bestMatch = null;
                let bestArea = Infinity;
                let bestTile = null;
                if (stickyTile) {
                    var stickyCheck = _checkLayerEntryAtPoint(stickyTile, center);
                    if (stickyCheck.inside) {
                        bestMatch = stickyDistrict;
                        bestArea = stickyCheck.area;
                        bestTile = stickyTile;
                    }
                }
                // Phase 1: narrow to entries whose bbox covers center via the
                // Flatbush index. Falls back to a full scan when no index.
                var dpcCands = _candidateIndicesAtPoint(dpLayerData, center);
                for (var dpci = 0; dpci < dpcCands.length; dpci++) {
                    const tile = dpLayerData[dpcCands[dpci]];
                    if (tile === bestTile) continue; // skip sticky tile, already seeded
                    var check = _checkLayerEntryAtPoint(tile, center);
                    if (check.inside) {
                        const area = check.area;
                        if (area >= bestArea) continue;
                        // Try productPurchaseID first (from Firebase dpURLlink data)
                        let district = findDistrictByPurchaseId(tile.productPurchaseID);
                        // Fallback: try tile.id (Firebase key)
                        if (!district) district = findDistrictByPurchaseId(tile.id);
                        // Fallback: try link path parts (e.g. "/mumbai/dp" → try "mumbai", "dp")
                        if (!district && tile.link) {
                            const parts = tile.link.replace(/^\/|\/$/g, '').split('/');
                            for (const part of parts) {
                                district = findDistrictByPurchaseId(part);
                                if (district) break;
                            }
                        }
                        if (district) {
                            bestMatch = district;
                            bestArea = area;
                            bestTile = tile;
                        }
                    }
                }
                if (bestMatch) {
                    stickyTile = bestTile;
                    stickyDistrict = bestMatch;
                    return bestMatch;
                }
            }

            stickyTile = null;
            stickyDistrict = null;
            return null;
        }

        // Pure point -> DP region lookup for the hover region-name tooltip. Mirrors
        // the smallest-area selection of findDistrictAtCenter but deliberately does
        // NOT read or mutate stickyTile/stickyDistrict — that sticky state belongs
        // to the center-based zoom paywall and must stay isolated from hover.
        // Returns { entry, district } or null. References the live dpLayerData
        // binding each call so a mid-session layer refresh stays correct.
        function findDpEntryAtPoint(point) {
            if (!point || !dpLayerData || dpLayerData.length === 0) return null;
            let bestEntry = null, bestDistrict = null, bestArea = Infinity;
            const cands = _candidateIndicesAtPoint(dpLayerData, point);
            for (let i = 0; i < cands.length; i++) {
                const tile = dpLayerData[cands[i]];
                const check = _checkLayerEntryAtPoint(tile, point);
                if (!check.inside || check.area >= bestArea) continue;
                // Same district-resolution fallback chain as findDistrictAtCenter.
                let district = findDistrictByPurchaseId(tile.productPurchaseID);
                if (!district) district = findDistrictByPurchaseId(tile.id);
                if (!district && tile.link) {
                    const parts = tile.link.replace(/^\/|\/$/g, '').split('/');
                    for (const part of parts) { district = findDistrictByPurchaseId(part); if (district) break; }
                }
                if (!district) continue;
                bestEntry = tile; bestDistrict = district; bestArea = check.area;
            }
            return bestEntry ? { entry: bestEntry, district: bestDistrict } : null;
        }

        // Gesture-level memoization of findDistrictAtCenter. zoom_changed and
        // center_changed (via checkRegionOnMove) both call this, plus the idle
        // re-check at the end of a locked gesture — that's 3+ full polygon scans
        // per tick on the main thread. Cache is keyed on center+zoom rounded to
        // ~10 m so real pans invalidate it immediately.
        let _districtCache = { key: null, value: null };
        function findDistrictAtCenterCached() {
            if (!map) return null;
            const c = map.getCenter();
            const key = c.lat().toFixed(4) + ',' + c.lng().toFixed(4) + '@' + map.getZoom();
            if (_districtCache.key === key) return _districtCache.value;
            const v = findDistrictAtCenter();
            _districtCache = { key: key, value: v };
            return v;
        }

        // Look up a productPurchaseID in menuData to get district name and purchase info
        function findDistrictByPurchaseId(purchaseId) {
            if (!purchaseId) return null;
            const pid = purchaseId.toLowerCase().replace(/gst$/, '');
            const pidNoPrefix = pid.replace(/^district/, '');

            // Pass 1: Strict matching (exact or prefix-stripped equality)
            for (const item of menuData) {
                if (!item.productPurchaseID) continue;
                const itemPid = item.productPurchaseID.toLowerCase().replace(/gst$/, '');
                const itemPidNoPrefix = itemPid.replace(/^district/, '');
                if (itemPid === pid || itemPidNoPrefix === pidNoPrefix) {
                    return { productPurchaseID: item.productPurchaseID, districtName: item.district || item.state };
                }
            }

            return null;
        }

        function disableMapInteraction() {
            mapInteractionDisabled = true;
            if (map) map.setOptions({ draggable: false, scrollwheel: false, disableDoubleClickZoom: true, zoomControl: false, gestureHandling: 'none' });
        }

        function enableMapInteraction() {
            mapInteractionDisabled = false;
            if (map) map.setOptions({ draggable: true, scrollwheel: true, disableDoubleClickZoom: false, zoomControl: true, gestureHandling: 'greedy' });
        }

        function showZoomRestrictionDialog(district) {
            const overlay = document.getElementById('zoom-restrict-overlay');
            const title = document.getElementById('zoom-restrict-title');
            const desc = document.getElementById('zoom-restrict-desc');
            const regionInfo = document.getElementById('zoom-restrict-region');
            const actionBtn = document.getElementById('zoom-restrict-action');
            const priceEl = document.getElementById('zoom-price-amount');

            lastRestrictedDistrict = district;

            // Restore cards + support (may have been changed by showNoDataDialog)
            document.getElementById('zoom-restrict-support').style.display = '';
            document.getElementById('pd-plan-tabs').style.display = '';
            // Restore the web-only notice + amber styling (showNoDataDialog strips them)
            document.getElementById('zoom-restrict-weblabel').style.display = 'block';
            var infoBox = document.getElementById('zoom-restrict-info');
            infoBox.style.background = '#fff8e1';
            infoBox.style.borderLeft = '3px solid #f9a825';
            infoBox.style.padding = '12px 14px';
            desc.style.color = '';
            // Drop the redundant "Access high-resolution…" line in the purchase dialog
            // (it duplicates the title). showNoDataDialog re-shows this shared span.
            desc.style.display = 'none';

            if (district) {
                title.textContent = 'Web Unlock ' + district.districtName;
                regionInfo.textContent = district.districtName + ' Region';
                regionInfo.style.display = 'block';
            } else {
                title.textContent = 'Web Unlock Premium Maps';
                regionInfo.style.display = 'none';
            }

            // Display one-time price
            var pid = district ? district.productPurchaseID : 'default';
            var price = cachedPricing.get(pid) || cachedPricing.get('default') || null;
            if (price) {
                priceEl.textContent = '\u20B9' + price;
            } else {
                priceEl.textContent = '...';
                var priceCheck = setInterval(function() {
                    var p = cachedPricing.get(pid) || cachedPricing.get('default');
                    if (p) { priceEl.textContent = '\u20B9' + p; clearInterval(priceCheck); }
                }, 500);
                setTimeout(function() { clearInterval(priceCheck); }, 10000);
            }

            // Display subscription price
            var subPriceEl = document.getElementById('zoom-sub-price-amount');
            var subPricing = cachedSubPricing.get(pid) || cachedSubPricing.get('default') || null;
            var subPrice = subPricing ? (subPricing.weeklyPrice || subPricing) : null;
            if (subPrice) {
                subPriceEl.textContent = '\u20B9' + subPrice;
            } else {
                subPriceEl.textContent = '...';
                var subCheck = setInterval(function() {
                    var sp = cachedSubPricing.get(pid) || cachedSubPricing.get('default');
                    var spv = sp ? (sp.weeklyPrice || sp) : null;
                    if (spv) { subPriceEl.textContent = '\u20B9' + spv; clearInterval(subCheck); }
                }, 500);
                setTimeout(function() { clearInterval(subCheck); }, 10000);
            }

            disableMapInteraction();

            // Replace one-time button to remove old listeners
            const newBtn = actionBtn.cloneNode(true);
            newBtn.id = 'zoom-restrict-action';
            newBtn.style.background = '#2196F3';
            actionBtn.parentNode.replaceChild(newBtn, actionBtn);

            newBtn.addEventListener('click', () => {
                overlay.classList.remove('open');
                enableMapInteraction();
                smoothZoomTo(MAX_FREE_ZOOM - 1);
                setTimeout(() => {
                    if (district) buyRegion(district.productPurchaseID, district.districtName);
                    else openRegionsBrowser();
                }, 300);
            });

            // Replace subscribe button to remove old listeners
            var subActionBtn = document.getElementById('zoom-restrict-sub-action');
            var newSubBtn = subActionBtn.cloneNode(true);
            newSubBtn.id = 'zoom-restrict-sub-action';
            newSubBtn.style.background = '#4CAF50';
            subActionBtn.parentNode.replaceChild(newSubBtn, subActionBtn);

            // If the user already has a halted/pending/grace subscription for
            // this region, tapping subscribe RECOVERS (renews) the SAME
            // subscription rather than creating a new one (createSubscription
            // returns action:"recover"). Label the button to match the Renew
            // banner / My Purchases wording so the user knows it's a renewal.
            var existingSub = activeSubscriptions.get(pid);
            var subRecoverable = !!(existingSub && (
                existingSub.status === 'halted'
                || existingSub.status === 'pending'
                || (existingSub.graceAppliedThisCycle && Number(existingSub.graceExpiry || 0) > Date.now())));
            if (subRecoverable) {
                newSubBtn.textContent = 'Renew Subscription';
            }

            newSubBtn.addEventListener('click', () => {
                overlay.classList.remove('open');
                enableMapInteraction();
                smoothZoomTo(MAX_FREE_ZOOM - 1);
                setTimeout(() => {
                    if (district) subscribeRegion(district.productPurchaseID, district.districtName);
                    else openRegionsBrowser();
                }, 300);
            });

            document.getElementById('zoom-restrict-cancel').onclick = () => {
                overlay.classList.remove('open');
                enableMapInteraction();
                zoomBypassActive = true;
                smoothZoomTo(MAX_FREE_ZOOM - 1);
                google.maps.event.addListenerOnce(map, 'idle', () => { zoomBypassActive = false; });
            };

            document.getElementById('zoom-restrict-support').onclick = () => {
                overlay.classList.remove('open');
                if (!currentUser) {
                    pendingPurchase = null;
                    document.getElementById('auth-dialog-desc').textContent = 'Please sign in to contact support.';
                    document.getElementById('auth-dialog-weblabel').style.display = 'none';
                    document.getElementById('auth-dialog-overlay').classList.add('open');
                    return;
                }
                openSupportForm(district, true);
            };

            overlay.classList.add('open');

            // Peek animation: briefly show second card on small screens
            var pdScroll = document.getElementById('pd-cards-scroll');
            if (pdScroll && window.innerWidth <= 520) {
                pdScroll.scrollLeft = 0;
                var peekCancelled = false;
                var cancelPeek = function() { peekCancelled = true; pdScroll.removeEventListener('touchstart', cancelPeek); };
                pdScroll.addEventListener('touchstart', cancelPeek, { once: true });
                setTimeout(function() {
                    if (peekCancelled) return;
                    pdScroll.scrollTo({ left: pdScroll.scrollWidth - pdScroll.clientWidth, behavior: 'smooth' });
                    setTimeout(function() {
                        if (peekCancelled) return;
                        pdScroll.scrollTo({ left: 0, behavior: 'smooth' });
                        pdScroll.removeEventListener('touchstart', cancelPeek);
                    }, 800);
                }, 500);
            }

            // Cycle app hints (Android / Microsoft Store) — alternate start each time
            var appScroll = document.getElementById('pd-app-hints-scroll');
            var appDots = document.getElementById('pd-app-hint-dots');
            if (appScroll) {
                var dotEls = appDots ? appDots.querySelectorAll('.pd-app-hint-dot') : [];
                var appCycleTimer = null;
                function updateAppDots() {
                    if (!dotEls.length) return;
                    var idx = appScroll.scrollLeft > appScroll.scrollWidth / 4 ? 1 : 0;
                    dotEls.forEach(function(d, i) {
                        d.classList.toggle('pd-app-hint-dot-active', i === idx);
                    });
                }
                function stopAppCycle() {
                    if (appCycleTimer) { clearInterval(appCycleTimer); appCycleTimer = null; }
                }
                var lastApp = sessionStorage.getItem('pd-app-last') || 'android';
                if (lastApp === 'android') {
                    appScroll.scrollLeft = appScroll.scrollWidth - appScroll.clientWidth;
                    sessionStorage.setItem('pd-app-last', 'windows');
                } else {
                    appScroll.scrollLeft = 0;
                    sessionStorage.setItem('pd-app-last', 'android');
                }
                updateAppDots();
                appCycleTimer = setInterval(function() {
                    if (!overlay.classList.contains('open')) { stopAppCycle(); return; }
                    appScroll.scrollTo({ left: appScroll.scrollLeft > 0 ? 0 : appScroll.scrollWidth, behavior: 'smooth' });
                }, 2000);
                appScroll.addEventListener('touchstart', stopAppCycle, { once: true });
                appScroll.addEventListener('scroll', updateAppDots, { passive: true });
                dotEls.forEach(function(d, i) {
                    d.addEventListener('click', function() {
                        stopAppCycle();
                        appScroll.scrollTo({ left: i === 0 ? 0 : appScroll.scrollWidth, behavior: 'smooth' });
                    });
                });
            }
        }

        // Friendly "you own a different region of this pair" clearance dialog.
        // Shown before the paywall when the user owns a confused-partner region
        // (e.g. owns Pune, zooming into PMRDA). Primary CTA hands off to the
        // normal purchase paywall for the accessed region.
        function showRegionMismatchDialog(district, owned) {
            const overlay = document.getElementById('region-mismatch-overlay');
            const titleEl = document.getElementById('region-mismatch-title');
            const ownedEl = document.getElementById('region-mismatch-owned');
            const unlockBtn = document.getElementById('region-mismatch-unlock');

            const accessedName = (district && district.districtName) ? district.districtName : 'this region';
            titleEl.textContent = accessedName + ' is a separate region';
            ownedEl.textContent = owned.ownedName;
            // Fill every accessed-region placeholder (green transition note + amber row).
            overlay.querySelectorAll('.region-mismatch-accessed').forEach(function (el) {
                el.textContent = accessedName;
            });
            unlockBtn.textContent = 'Unlock ' + accessedName;

            disableMapInteraction();

            // Replace the unlock button to drop any stale listeners from a prior open.
            const newUnlock = unlockBtn.cloneNode(true);
            unlockBtn.parentNode.replaceChild(newUnlock, unlockBtn);
            newUnlock.addEventListener('click', () => {
                // Hand off to the paywall WITHOUT corrupting the back-button history
                // stack. The dismiss observer (maps.html) pushes one history entry per
                // open dialog and calls history.back() when a dialog closes. If we close
                // THIS dialog and open the paywall in the same tick, the close's async
                // history.back() races the open's synchronous pushState, so the paywall
                // is left without a clean live history entry. Its buttons — Not now AND
                // 7-day / Subscribe (which also hand off to Razorpay's own history push)
                // — then run history.back() against a stale stack and the tab navigates
                // away / closes. It's intermittent because it depends on popstate timing,
                // so a fixed setTimeout only narrows the race instead of closing it.
                //
                // Deterministic fix: close THIS dialog, wait for its history.back() to
                // actually LAND (the popstate it fires), and only THEN open the paywall
                // so it pushes its own clean entry from maps.html.
                var handedOff = false;
                function openPaywall() {
                    if (handedOff) return;
                    handedOff = true;
                    window.removeEventListener('popstate', onPop);
                    showZoomRestrictionDialog(district);
                }
                function onPop() { setTimeout(openPaywall, 0); }
                window.addEventListener('popstate', onPop);
                overlay.classList.remove('open');   // observer fires history.back() → popstate
                // Fallback: if no popstate arrives (e.g. dialog wasn't history-tracked), still open.
                setTimeout(openPaywall, 500);
            });

            document.getElementById('region-mismatch-cancel').onclick = () => {
                overlay.classList.remove('open');
                enableMapInteraction();
                zoomBypassActive = true;
                smoothZoomTo(MAX_FREE_ZOOM - 1);
                google.maps.event.addListenerOnce(map, 'idle', () => { zoomBypassActive = false; });
            };

            overlay.classList.add('open');
        }

        function showNoDataDialog() {
            const overlay = document.getElementById('zoom-restrict-overlay');
            const title = document.getElementById('zoom-restrict-title');
            const desc = document.getElementById('zoom-restrict-desc');
            const regionInfo = document.getElementById('zoom-restrict-region');
            const supportBtn = document.getElementById('zoom-restrict-support');

            title.textContent = 'No Map Data Available';
            desc.style.display = '';  // re-show shared span (purchase dialog hides it)
            desc.textContent = 'There are no development plan maps available for this area. Browse available regions to explore maps.';
            // Hide the web-only purchase notice + amber styling — irrelevant on the no-data dialog
            document.getElementById('zoom-restrict-weblabel').style.display = 'none';
            var infoBox = document.getElementById('zoom-restrict-info');
            infoBox.style.background = 'none';
            infoBox.style.borderLeft = 'none';
            infoBox.style.padding = '0';
            desc.style.color = '#666';
            regionInfo.style.display = 'none';
            supportBtn.style.display = 'none';
            document.getElementById('zoom-restrict-price').style.display = 'none';
            // Hide plan cards carousel
            document.getElementById('pd-plan-tabs').style.display = 'none';

            // Close sidebar if open so dialog is visible
            if (document.getElementById('sidebar-panel').classList.contains('open')) {
                document.getElementById('sidebar-panel').classList.remove('open');
                document.getElementById('sidebar-overlay').classList.remove('open');
            }

            disableMapInteraction();

            // Remove any previous browse button
            var oldBrowse = document.getElementById('nodata-browse-btn');
            if (oldBrowse) oldBrowse.remove();

            // Insert Browse button before cancel (outside the hidden cards)
            var cancelBtn = document.getElementById('zoom-restrict-cancel');
            var browseBtn = document.createElement('button');
            browseBtn.id = 'nodata-browse-btn';
            browseBtn.textContent = 'Browse Available Regions';
            browseBtn.className = 'pd-cta';
            browseBtn.style.cssText = 'margin-bottom:8px;';
            cancelBtn.parentNode.insertBefore(browseBtn, cancelBtn);

            browseBtn.addEventListener('click', function() {
                overlay.classList.remove('open');
                enableMapInteraction();
                supportBtn.style.display = '';
                browseBtn.remove();
                zoomBypassActive = true;
                smoothZoomTo(MAX_FREE_ZOOM - 1);
                google.maps.event.addListenerOnce(map, 'idle', function() { zoomBypassActive = false; });
                setTimeout(function() { openRegionsBrowser(); }, 0);
            });

            var newCancel = cancelBtn.cloneNode(true);
            newCancel.id = 'zoom-restrict-cancel';
            cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
            newCancel.addEventListener('click', function() {
                overlay.classList.remove('open');
                enableMapInteraction();
                supportBtn.style.display = '';
                browseBtn.remove();
                zoomBypassActive = true;
                smoothZoomTo(MAX_FREE_ZOOM - 1);
                google.maps.event.addListenerOnce(map, 'idle', function() { zoomBypassActive = false; });
            });

            overlay.classList.add('open');
        }

        let unlockToastTimer = null;
        function showUnlockToast(regionName) {
            if (isEmbedMode) return;
            const toast = document.getElementById('unlock-toast');
            document.getElementById('unlock-toast-text').textContent = regionName + ' — Premium unlocked';
            toast.classList.add('show');
            if (unlockToastTimer) clearTimeout(unlockToastTimer);
            unlockToastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
        }

        function updateRegionStatus() {
            const el = document.getElementById('region-status');
            const planEl = document.getElementById('region-plan-status');
            const district = findDistrictAtCenter();
            if (district) {
                el.style.display = 'inline';
                el.textContent = district.districtName;
                if (hasPurchase(district.productPurchaseID)) {
                    const plan = getPurchasePlan(district.productPurchaseID);
                    const sub = activeSubscriptions.get(district.productPurchaseID);
                    var planLabel;
                    if (plan === 'subscription' && sub) {
                        var periodLabel = (!sub.currentPeriodStart || !sub.currentPeriodEnd) ? 'Weekly' : (function() { var d = Math.round((sub.currentPeriodEnd - sub.currentPeriodStart) / 86400000); return d <= 1 ? 'Daily' : d <= 7 ? 'Weekly' : d <= 31 ? 'Monthly' : d + '-Day'; })();
                        planLabel = sub.status === 'cancelled' ? 'Sub (Cancelling)' : periodLabel + ' Sub';
                    } else if (plan === 'professional') {
                        planLabel = 'Mobile + Web';
                    } else if (plan === 'web') {
                        planLabel = 'Web Only';
                    } else if (plan === 'override') {
                        planLabel = 'Override';
                    } else {
                        planLabel = 'Active';
                    }
                    el.className = 'region-status subscribed';
                    planEl.style.display = 'inline';
                    planEl.className = 'region-status subscribed';
                    planEl.textContent = planLabel;
                } else {
                    el.className = 'region-status not-subscribed';
                    planEl.style.display = 'inline';
                    planEl.className = 'region-status not-subscribed';
                    planEl.textContent = 'Not Subscribed';
                }
            } else {
                el.style.display = 'none';
                planEl.style.display = 'none';
            }

            // Update floating button: unlock region vs sign-in
            var fab = document.getElementById('floating-signin-btn');
            var fabIcon = document.getElementById('floating-btn-icon');
            var fabText = document.getElementById('floating-btn-text');
            if (fab && fabIcon && fabText) {
                var signedIn = currentUser && !currentUser.isAnonymous;
                var lockSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#E65100"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
                var googleSvg = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#34A853" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#FBBC05" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

                if (district && !hasPurchase(district.productPurchaseID)) {
                    // In unpurchased region — show unlock button
                    var shortName = district.districtName.split('(')[0].split('/')[0].trim();
                    if (shortName.length > 18) shortName = shortName.substring(0, 16) + '..';
                    _floatingBtnMode = 'unlock';
                    _floatingBtnDistrict = district;
                    fabIcon.innerHTML = lockSvg;
                    fabText.textContent = 'Unlock ' + shortName;
                    fab.style.background = '#FFF3E0';
                    fab.style.borderColor = '#FFB74D';
                    fab.style.color = '#E65100';
                    fab.style.display = 'flex';
                } else if (!signedIn) {
                    // Not in a region or purchased — show sign-in
                    _floatingBtnMode = 'signin';
                    _floatingBtnDistrict = null;
                    fabIcon.innerHTML = googleSvg;
                    fabText.textContent = 'Sign in with Google';
                    fab.style.background = '#fff';
                    fab.style.borderColor = '#dadce0';
                    fab.style.color = '#333';
                    fab.style.display = 'flex';
                } else {
                    // Signed in + purchased or no region — hide
                    fab.style.display = 'none';
                }
            }

            return district;
        }

        // Region detection on camera move — locks/unlocks zoom based on purchase status
        function checkRegionOnMove() {
            if (zoomBypassActive || mapInteractionDisabled) return;

            const district = findDistrictAtCenterCached();
            const regionId = district ? district.productPurchaseID : null;

            // When no tiles are loaded at center (null), don't treat as a region change —
            // tiles may just be loading/unloading during zoom. Keep previous zoom state.
            if (!district) return;

            const regionChanged = (regionId !== lastCheckedRegionId);

            // If the region appears to have changed, verify the center actually moved (panning).
            // During zoom-only, tiles load/unload causing false region changes
            // (e.g., small region's tile unloads, larger purchased tile takes over).
            if (regionChanged && lastCheckedRegionId !== null) {
                const c = map.getCenter();
                const dl = Math.abs(c.lat() - lastRegionCenterLat);
                const dn = Math.abs(c.lng() - lastRegionCenterLng);
                if (dl < 0.005 && dn < 0.005) {
                    // Center barely moved (~500m) — this is a zoom, not a pan.
                    // Don't switch regions based on tile loading artifacts.
                    return;
                }
            }

            // Keep reference position fresh while staying in the same region,
            // so the zoom-distance guard above always compares against a recent position.
            // Without this, cumulative zoom drift defeats the guard for small polygons.
            if (!regionChanged) {
                const c = map.getCenter();
                lastRegionCenterLat = c.lat();
                lastRegionCenterLng = c.lng();
            }

            if (regionChanged) {
                lastCheckedRegionId = regionId;
                bannerDismissedForRegion = null;
                const c = map.getCenter();
                lastRegionCenterLat = c.lat();
                lastRegionCenterLng = c.lng();
                // Poll purchase status on region change (only for Google-signed-in users)
                if (currentUser && !currentUser.isAnonymous) fetchPurchaseStatus();
                // Update bottom bar immediately on region change so it stays in sync
                updateRegionStatus();
            }

            const overlay = document.getElementById('zoom-restrict-overlay');

            if (hasPurchase(district.productPurchaseID)) {
                // Purchased region — unlock zoom, dismiss dialog, show confirmation
                setMapMaxZoom(21);
                if (regionChanged && dialogTriggeredByRegionEntry && overlay.classList.contains('open')) {
                    overlay.classList.remove('open');
                    enableMapInteraction();
                }
                if (regionChanged && regionId !== lastToastedRegionId) {
                    lastToastedRegionId = regionId;
                    showUnlockToast(district.districtName);
                }
                return;
            }

            // Unpurchased region — always enforce zoom lock
            lastToastedRegionId = null;
            setMapMaxZoom(MAX_FREE_ZOOM);
        }

        // Layer visibility and data
        var cfCookiesReady = false; // Gate tile loading until CloudFront cookies are set
        var tilesInitiated = false; // Gate GeoJSON until tiles have started loading
        var layerDataFetched = false; // Prevent duplicate fetchLayerData() calls
        let isDPLayerVisible = true;
        let isVillageLayerVisible = true;
        let isShowingOldMaps = false;
        let oldDPDataAvailable = false;

        // Layer data by type
        let dpLayerData = [];
        let villageLayerData = [];
        let oldDPLayerData = [];

        // Village markers & purchase state
        let villageMarkers = new Map();      // villageName → google.maps.Marker
        let villagePurchases = new Map();    // villageName → { expiry, plan }
        let villageDataByName = new Map();   // villageName → villageLayerData item (for lookup)

        // Layer tracking
        let dpOverlays = new Map();
        let villageOverlays = new Map();
        let oldDPOverlays = new Map();

        // PERF (maps9): tile-cancellation glue. Iterates every CanvasMapType
        // currently on the map and aborts every Image fetch belonging to a
        // zoom level that isn't `currentZoom`.
        let _mmLastSeenZoom = -1;
        function _mmCancelStaleZoomTiles(currentZoom) {
            const all = [dpOverlays, villageOverlays, oldDPOverlays];
            for (let i = 0; i < all.length; i++) {
                const m = all[i];
                if (!m || typeof m.forEach !== 'function') continue;
                m.forEach(function(overlay) {
                    if (overlay && typeof overlay.cancelTilesNotAtZoom === 'function') {
                        overlay.cancelTilesNotAtZoom(currentZoom);
                    }
                });
            }
        }

        // Tile loading status tracking
        let dpTileStatus = [];
        let villageTileStatus = [];
        let oldDPTileStatus = [];

        // Generation counter -- increments on every viewport change.
        // Stale results from old generations are discarded (like Android coroutine job cancellation).
        let currentGeneration = 0;

        // Layer load status
        let dpDataLoaded = false;
        let villageDataLoaded = false;
        let oldDPDataLoaded = false;

        // Constants from your Android app
        const DEVELOPMENT_PLAN = "Development Plan";
        const VILLAGE_PLAN = "Village Plans";
        const OLD_DP_PLAN = "Old Development Plan";

        const DP_URL_DATABASE_NAME = "d1";
        const VILLAGE_URL_DATABASE_NAME = "d2";
        const OLD_DP_URL_DATABASE_NAME = "d3";
        // dpplans.com Cloudflare Pages build doesn't ship data/database/ — fetch from mapmagician.in.
        const LAYER_JSON_BASE = ON_DPPLANS ? "https://www.mapmagician.in/data/database" : "data/database";

        // Map settings
        const MAX_ZOOM_FOR_DP = 18;
        const MIN_ZOOM_FOR_DP = 11;
        const MAX_ZOOM_FOR_VILLAGEMAP = 18;
        const MIN_ZOOM_FOR_VILLAGEMAP = 11;
        const MAX_ZOOM_FOR_OLD_DP = 18;
        const MIN_ZOOM_FOR_OLD_DP = 11;
        
        // tileProxyUrl removed — tiles served directly from CloudFront with signed cookies
        const tileBaseUrl = `https://${TILE_HOST}`;

        // ---------- Tile cache: IndexedDB (byte-level persistent cache) ----------
        // Stores PNG blobs keyed by full URL so repeat views bypass CloudFront.
        // Revocation: on fetchPurchaseStatus(), evict tiles whose folder is no
        // longer in the caller's active-purchase set (zoom > 14 only).
        // Graceful degradation: if IDB or cross-origin fetch fails, callers fall
        // back to a direct img.src assignment — same behavior as pre-cache.
        const TILE_DB_NAME = 'mapmagician_tiles';
        const TILE_DB_VERSION = 1;
        const TILE_CACHE_MAX_BYTES = 500 * 1024 * 1024;
        const TILE_CACHE_EVICT_TO = 400 * 1024 * 1024;
        let _tileDBPromise = null;
        let _tileCacheBytes = 0;
        let _tileCacheBytesInitialized = false;

        function openTileDB() {
            if (_tileDBPromise) return _tileDBPromise;
            _tileDBPromise = new Promise(function(resolve, reject) {
                const req = indexedDB.open(TILE_DB_NAME, TILE_DB_VERSION);
                req.onupgradeneeded = function(e) {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('tiles')) {
                        const store = db.createObjectStore('tiles', { keyPath: 'url' });
                        store.createIndex('by_cachedAt', 'cachedAt', { unique: false });
                        store.createIndex('by_folder', 'folder', { unique: false });
                    }
                };
                req.onsuccess = function() { resolve(req.result); };
                req.onerror = function() { reject(req.error); };
            }).catch(function(err) {
                _tileDBPromise = null;
                throw err;
            });
            return _tileDBPromise;
        }

        async function _initTileCacheBytes() {
            if (_tileCacheBytesInitialized) return;
            try {
                const db = await openTileDB();
                const store = db.transaction(['tiles'], 'readonly').objectStore('tiles');
                await new Promise(function(resolve) {
                    let total = 0;
                    const cur = store.openCursor();
                    cur.onsuccess = function(e) {
                        const c = e.target.result;
                        if (c) { total += (c.value.size || 0); c.continue(); }
                        else { _tileCacheBytes = total; _tileCacheBytesInitialized = true; resolve(); }
                    };
                    cur.onerror = function() { resolve(); };
                });
            } catch (e) { /* IDB unavailable; stay at 0 */ }
        }

        async function getTileFromDB(url) {
            try {
                const db = await openTileDB();
                const store = db.transaction(['tiles'], 'readonly').objectStore('tiles');
                return await new Promise(function(resolve) {
                    const req = store.get(url);
                    req.onsuccess = function() { resolve(req.result || null); };
                    req.onerror = function() { resolve(null); };
                });
            } catch (e) { return null; }
        }

        async function putTileInDB(record) {
            try {
                await _initTileCacheBytes();
                const db = await openTileDB();
                const tx = db.transaction(['tiles'], 'readwrite');
                tx.objectStore('tiles').put(record);
                _tileCacheBytes += record.size;
                await new Promise(function(resolve, reject) {
                    tx.oncomplete = resolve;
                    tx.onerror = function() { reject(tx.error); };
                });
                if (_tileCacheBytes > TILE_CACHE_MAX_BYTES) _evictOldestTiles();
            } catch (e) { /* opportunistic — swallow */ }
        }

        async function _evictOldestTiles() {
            try {
                const db = await openTileDB();
                const store = db.transaction(['tiles'], 'readwrite').objectStore('tiles');
                const index = store.index('by_cachedAt');
                await new Promise(function(resolve) {
                    const cur = index.openCursor();
                    cur.onsuccess = function(e) {
                        const c = e.target.result;
                        if (!c || _tileCacheBytes <= TILE_CACHE_EVICT_TO) return resolve();
                        _tileCacheBytes -= (c.value.size || 0);
                        c.delete();
                        c.continue();
                    };
                    cur.onerror = function() { resolve(); };
                });
            } catch (e) {}
        }

        async function revokeTilesNotInFolderSet(allowedFolders) {
            try {
                const db = await openTileDB();
                const store = db.transaction(['tiles'], 'readwrite').objectStore('tiles');
                let freed = 0;
                await new Promise(function(resolve) {
                    const cur = store.openCursor();
                    cur.onsuccess = function(e) {
                        const c = e.target.result;
                        if (!c) return resolve();
                        const v = c.value;
                        if (v.zoom > 14 && !allowedFolders.has(v.folder)) {
                            freed += (v.size || 0);
                            c.delete();
                        }
                        c.continue();
                    };
                    cur.onerror = function() { resolve(); };
                });
                _tileCacheBytes = Math.max(0, _tileCacheBytes - freed);
            } catch (e) {}
        }

        function _tileFolderFromUrl(url) {
            const m = url.match(/\/dpplans\/([^/]+)\//);
            return m ? m[1] : '';
        }

        // Walk layer data and return folders the user currently has access to.
        // Free layers (no productPurchaseID) are always included so cached free
        // tiles never get evicted on purchase-status refresh. Premium folders are
        // only included when activePurchases has a live entry for their pid.
        function _computeAllowedTileFolders() {
            const allowed = new Set();
            const layers = [
                typeof dpLayerData === 'undefined' ? [] : dpLayerData,
                typeof villageLayerData === 'undefined' ? [] : villageLayerData,
                typeof oldDPLayerData === 'undefined' ? [] : oldDPLayerData
            ];
            for (let li = 0; li < layers.length; li++) {
                const arr = layers[li] || [];
                for (let i = 0; i < arr.length; i++) {
                    const d = arr[i];
                    if (!d) continue;
                    const pid = d.productPurchaseID;
                    const isFree = !pid;
                    const isLive = pid && typeof hasPurchase === 'function' && hasPurchase(pid);
                    if (!isFree && !isLive) continue;
                    const m = (d.link || '').match(/\/dpplans\/([^/]+)\/?/);
                    if (m) allowed.add(m[1]);
                    if (d.subSheets) {
                        for (let si = 0; si < d.subSheets.length; si++) {
                            const sm = (d.subSheets[si].urlPrefix || '').match(/\/dpplans\/([^/]+)\/?/);
                            if (sm) allowed.add(sm[1]);
                        }
                    }
                }
            }
            return allowed;
        }

        // Returns a blob URL for the tile (cached or freshly fetched), or null
        // on any failure. Caller uses null as the signal to fall back to a
        // direct img.src = url assignment (pre-cache behavior). Each call
        // attempts independently — a transient failure does not disable the
        // cache for future tiles.
        async function loadTileWithCache(url, zoom) {
            const cached = await getTileFromDB(url);
            if (cached && cached.blob) {
                try { return URL.createObjectURL(cached.blob); }
                catch (e) { return null; }
            }
            try {
                const resp = await fetch(url, { credentials: 'include' });
                if (resp.status !== 200) return null;
                const blob = await resp.blob();
                const folder = _tileFolderFromUrl(url);
                putTileInDB({
                    url: url,
                    blob: blob,
                    size: blob.size,
                    folder: folder,
                    zoom: zoom,
                    cachedAt: Date.now()
                });
                return URL.createObjectURL(blob);
            } catch (e) {
                return null;
            }
        }

        // ---------- Village-boundary GeoJSON: IndexedDB wrapper ----------
        // Mirrors the Android Room schema (districts + villages). Polygons are stored
        // inline on each village record (IDB has no JOINs) — one getAll per district.
        const GEOJSON_DB_NAME = 'mapmagician_geojson';
        const GEOJSON_DB_VERSION = 2;
        let _geojsonDBPromise = null;
        function openGeoJsonDB() {
            if (_geojsonDBPromise) return _geojsonDBPromise;
            _geojsonDBPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(GEOJSON_DB_NAME, GEOJSON_DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('districts')) {
                        db.createObjectStore('districts', { keyPath: 'name' });
                    }
                    if (!db.objectStoreNames.contains('villages')) {
                        const store = db.createObjectStore('villages', { keyPath: 'id', autoIncrement: true });
                        store.createIndex('by_district', 'districtName', { unique: false });
                    }
                    if (!db.objectStoreNames.contains('icons')) {
                        db.createObjectStore('icons', { keyPath: 'name' });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            return _geojsonDBPromise;
        }
        function _idbTx(db, stores, mode) {
            const tx = db.transaction(stores, mode);
            return { tx, ...Object.fromEntries(stores.map(s => [s, tx.objectStore(s)])) };
        }
        function _idbReq(req) {
            return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        }
        async function putDistrict(record) {
            const db = await openGeoJsonDB();
            const { tx, districts } = _idbTx(db, ['districts'], 'readwrite');
            districts.put(record);
            return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        }
        async function getDistrict(name) {
            const db = await openGeoJsonDB();
            const { districts } = _idbTx(db, ['districts'], 'readonly');
            return _idbReq(districts.get(name));
        }
        async function putVillages(districtName, villageRecords) {
            const db = await openGeoJsonDB();
            const { tx, villages } = _idbTx(db, ['villages'], 'readwrite');
            // Clear existing villages for this district first (fresh load)
            const index = villages.index('by_district');
            const cursorReq = index.openCursor(IDBKeyRange.only(districtName));
            await new Promise((resolve, reject) => {
                cursorReq.onsuccess = (e) => {
                    const c = e.target.result;
                    if (c) { c.delete(); c.continue(); } else resolve();
                };
                cursorReq.onerror = () => reject(cursorReq.error);
            });
            for (const v of villageRecords) villages.add({ ...v, districtName });
            return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        }
        async function getVillagesForDistrict(districtName) {
            const db = await openGeoJsonDB();
            const { villages } = _idbTx(db, ['villages'], 'readonly');
            return _idbReq(villages.index('by_district').getAll(IDBKeyRange.only(districtName)));
        }
        async function deleteDistrict(name) {
            const db = await openGeoJsonDB();
            const { tx, districts, villages } = _idbTx(db, ['districts', 'villages'], 'readwrite');
            districts.delete(name);
            const cursorReq = villages.index('by_district').openCursor(IDBKeyRange.only(name));
            cursorReq.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
            return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        }
        async function getAllDistricts() {
            const db = await openGeoJsonDB();
            const { districts } = _idbTx(db, ['districts'], 'readonly');
            return _idbReq(districts.getAll());
        }

        // ---------- loadDistrictGeoJson: download → extract → parse → persist ----------
        // Mirrors Android's downloadAndUnzipGeoJsonFile + GeoJsonToDatabaseConverter.
        const _geojsonInFlight = new Map();          // dedup concurrent loads for same district
        let _geojsonSemaphoreAvail = GEOJSON_MAX_CONCURRENT_DOWNLOADS;
        const _geojsonSemaphoreQueue = [];
        function _geojsonAcquire() {
            if (_geojsonSemaphoreAvail > 0) { _geojsonSemaphoreAvail--; return Promise.resolve(); }
            return new Promise(resolve => _geojsonSemaphoreQueue.push(resolve));
        }
        function _geojsonRelease() {
            const next = _geojsonSemaphoreQueue.shift();
            if (next) next(); else _geojsonSemaphoreAvail++;
        }
        function _districtFileName(districtName) {
            return districtName.toLowerCase().replace(/\s+/g, '_');
        }
        function _ringToLatLngs(ring) {
            // GeoJSON is [lng, lat]; Google Maps wants {lat, lng}
            const out = new Array(ring.length);
            for (let i = 0; i < ring.length; i++) {
                out[i] = { lat: ring[i][1], lng: ring[i][0] };
            }
            return out;
        }
        function _computeBboxFromRings(rings) {
            let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity;
            for (const ring of rings) {
                for (const pt of ring) {
                    if (pt.lat > n) n = pt.lat;
                    if (pt.lat < s) s = pt.lat;
                    if (pt.lng > e) e = pt.lng;
                    if (pt.lng < w) w = pt.lng;
                }
            }
            return { n, s, e, w };
        }
        function _parseGeoJsonFeature(feat) {
            const props = feat.properties || {};
            const villageName = props.VILLAGE || props.NAME || props.village || 'Unknown';
            const talukaName = props.TALUKA || props.TEHSIL || props.taluka || '';
            const geom = feat.geometry;
            if (!geom) return null;
            const rings = [];                         // outer rings only (skip holes)
            if (geom.type === 'Polygon' && Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
                rings.push(_ringToLatLngs(geom.coordinates[0]));
            } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                for (const poly of geom.coordinates) {
                    if (Array.isArray(poly) && poly.length > 0) rings.push(_ringToLatLngs(poly[0]));
                }
            } else {
                return null;
            }
            if (rings.length === 0) return null;
            const bounds = _computeBboxFromRings(rings);
            return {
                villageName, talukaName,
                centerLat: (bounds.n + bounds.s) / 2,
                centerLng: (bounds.e + bounds.w) / 2,
                bounds,
                polygons: rings
            };
        }
        // ---------- Geojson Web Worker (maps8: maps7 canvas overlay + maps6 worker) ----------
        // Multi-part Pune was the remaining bottleneck: many sub-region zips, each
        // requiring main-thread fetch + JSZip + JSON.parse + feature parsing, all
        // gated through a semaphore that capped concurrency to 3. This worker moves
        // ALL of that off the main thread. Multiple postMessage calls run in parallel
        // inside the worker (each onmessage is its own async chain), so the browser's
        // HTTP/2 limits become the real bound — no main-thread blocking, no semaphore.
        const _geojsonWorkerCode = `
            importScripts('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');

            function _ringToLatLngs(ring) {
                const out = new Array(ring.length);
                for (let i = 0; i < ring.length; i++) {
                    out[i] = { lat: ring[i][1], lng: ring[i][0] };
                }
                return out;
            }
            function _computeBboxFromRings(rings) {
                let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity;
                for (const ring of rings) {
                    for (const pt of ring) {
                        if (pt.lat > n) n = pt.lat;
                        if (pt.lat < s) s = pt.lat;
                        if (pt.lng > e) e = pt.lng;
                        if (pt.lng < w) w = pt.lng;
                    }
                }
                return { n: n, s: s, e: e, w: w };
            }
            function _parseGeoJsonFeature(feat) {
                const props = feat.properties || {};
                const villageName = props.VILLAGE || props.NAME || props.village || 'Unknown';
                const talukaName = props.TALUKA || props.TEHSIL || props.taluka || '';
                const geom = feat.geometry;
                if (!geom) return null;
                const rings = [];
                if (geom.type === 'Polygon' && Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
                    rings.push(_ringToLatLngs(geom.coordinates[0]));
                } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                    for (const poly of geom.coordinates) {
                        if (Array.isArray(poly) && poly.length > 0) rings.push(_ringToLatLngs(poly[0]));
                    }
                } else {
                    return null;
                }
                if (rings.length === 0) return null;
                const bounds = _computeBboxFromRings(rings);
                return {
                    villageName: villageName,
                    talukaName: talukaName,
                    centerLat: (bounds.n + bounds.s) / 2,
                    centerLng: (bounds.e + bounds.w) / 2,
                    bounds: bounds,
                    polygons: rings
                };
            }

            self.onmessage = async function(e) {
                const msg = e.data;
                const requestId = msg.requestId;
                try {
                    const res = await fetch(msg.url, { credentials: 'include' });
                    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + msg.url);
                    const blob = await res.blob();
                    const zip = await JSZip.loadAsync(blob);
                    const entry = Object.values(zip.files).find(function(f) { return !f.dir && f.name.toLowerCase().endsWith('.geojson'); });
                    if (!entry) throw new Error('No .geojson file inside ' + msg.districtName);
                    const text = await entry.async('string');
                    const geojson = JSON.parse(text);
                    const features = (geojson && geojson.features) || [];
                    const villageRecords = [];
                    let dn = -Infinity, ds = Infinity, de = -Infinity, dw = Infinity;
                    for (let i = 0; i < features.length; i++) {
                        const rec = _parseGeoJsonFeature(features[i]);
                        if (rec) {
                            villageRecords.push(rec);
                            if (rec.bounds.n > dn) dn = rec.bounds.n;
                            if (rec.bounds.s < ds) ds = rec.bounds.s;
                            if (rec.bounds.e > de) de = rec.bounds.e;
                            if (rec.bounds.w < dw) dw = rec.bounds.w;
                        }
                    }
                    self.postMessage({
                        requestId: requestId,
                        ok: true,
                        villageRecords: villageRecords,
                        districtBounds: { n: dn, s: ds, e: de, w: dw }
                    });
                } catch (err) {
                    self.postMessage({
                        requestId: requestId,
                        ok: false,
                        error: String((err && err.message) || err)
                    });
                }
            };
        `;
        const _geojsonWorker = new Worker(URL.createObjectURL(new Blob([_geojsonWorkerCode], { type: 'application/javascript' })));
        const _geojsonWorkerPending = new Map(); // requestId -> { resolve, reject }
        let _geojsonWorkerNextId = 1;
        _geojsonWorker.onmessage = function(e) {
            const data = e.data || {};
            const pending = _geojsonWorkerPending.get(data.requestId);
            if (!pending) return;
            _geojsonWorkerPending.delete(data.requestId);
            if (data.ok) {
                pending.resolve({ villageRecords: data.villageRecords, districtBounds: data.districtBounds });
            } else {
                pending.reject(new Error(data.error || 'geojson worker failed'));
            }
        };
        _geojsonWorker.onerror = function(e) {
            console.error('[geojson worker] error:', (e && (e.message || e.filename)) || e);
        };
        function _runGeojsonWorker(districtName, url) {
            const requestId = _geojsonWorkerNextId++;
            return new Promise(function(resolve, reject) {
                _geojsonWorkerPending.set(requestId, { resolve: resolve, reject: reject });
                _geojsonWorker.postMessage({ requestId: requestId, districtName: districtName, url: url });
            });
        }

        async function loadDistrictGeoJson(districtName) {
            if (!districtName) throw new Error('districtName required');
            // Cache hit → load from IDB
            const existing = await getDistrict(districtName);
            if (existing) {
                const villages = await getVillagesForDistrict(districtName);
                if (villages && villages.length > 0) {
                    return villages;
                }
            }
            // Dedup in-flight
            if (_geojsonInFlight.has(districtName)) return _geojsonInFlight.get(districtName);
            const p = (async () => {
                // PERF (maps8): semaphore acquire/release REMOVED. The worker handles
                // its own concurrency, and the browser already caps HTTP/2 streams
                // per origin. The 3-deep semaphore was forcing multi-part Pune
                // sub-regions into sequential batches of 3, which was the dominant
                // remaining cost. Now all sub-regions start fetching at once.
                try {
                    const fileName = _districtFileName(districtName);
                    // CloudFront-hosted zip. URL is already absolute; worker
                    // fetches with credentials to pass signed-cookie check.
                    const url = GEOJSON_BASE_PATH + fileName + '.zip';
                    // PERF (maps8): fetch + JSZip + JSON.parse + _parseGeoJsonFeature
                    // loop run inside _geojsonWorker. Main thread stays responsive
                    // even when 5+ Pune sub-regions are loading in parallel.
                    const result = await _runGeojsonWorker(districtName, url);
                    const villageRecords = result.villageRecords;
                    const districtBounds = result.districtBounds;
                    await putVillages(districtName, villageRecords);
                    await putDistrict({
                        name: districtName,
                        bounds: districtBounds,
                        featureCount: villageRecords.length,
                        downloadedAt: Date.now()
                    });
                    // Re-read to get records with their auto-generated IDs
                    return await getVillagesForDistrict(districtName);
                } finally {
                    _geojsonInFlight.delete(districtName);
                }
            })();
            _geojsonInFlight.set(districtName, p);
            return p;
        }


        // ---------- Multi-district viewport rendering (mirrors Android GeoJsonOverlayManager) ----------
        // Each visible district gets its own color from GEOJSON_DISTRICT_COLORS.
        // Map<file, {districtName, villages[], colorIndex, polylineMap: Map (kept empty in maps7), loading}>
        const renderedDistricts = new Map();

        // PERF (maps7): single canvas-backed OverlayView replaces thousands of
        // google.maps.Polyline. The class itself is defined inside initMap so
        // google.maps.OverlayView is loaded by then; this is the reference the
        // rest of the geojson code uses to trigger redraws when data changes.
        let villageBoundaryOverlay = null;

        function _bboxIntersectsViewport(bounds, ne, sw) {
            // bounds: {n,s,e,w}; ne/sw are LatLng
            return bounds.s <= ne.lat() && bounds.n >= sw.lat() &&
                   bounds.w <= ne.lng() && bounds.e >= sw.lng();
        }
        function _removeAllVillagePolylines() {
            // PERF (maps7): no per-village Polylines to tear down — just clear
            // the data Map and let the canvas overlay redraw an empty viewport.
            renderedDistricts.clear();
            if (villageBoundaryOverlay) villageBoundaryOverlay.requestRedraw();
        }
        function clearDistrictVillages() {
            _removeAllVillagePolylines();
        }
        function updateVillagePolylines() {
            // PERF (maps7): per-village google.maps.Polyline replaced by a
            // single VillageBoundaryOverlay (canvas). Google Maps already calls
            // the overlay's draw() automatically on every pan/zoom; this
            // function only needs to nudge the canvas when the underlying
            // renderedDistricts data changed (e.g. after an async district
            // load completes or the user toggled the boundary layer).
            if (villageBoundaryOverlay) villageBoundaryOverlay.requestRedraw();
        }

        // ---------- Solapur decorative overlay (labels + TP scheme + archaeological) ----------
        // Loaded lazily the first time the Solapur district bounds intersect the viewport.
        // Data file: data/solapur_overlay.json (ported from Android Constants.kt).
        let solapurOverlayLoadStarted = false;
        let solapurOverlayLoaded = false;
        const solapurLabelOverlays = []; // google.maps.GroundOverlay instances
        const solapurTpSchemeLines = [];

        function _parseKmlPolyline(kmlString) {
            // Accepts "lng,lat,0 lng,lat,0 ..." or "lng,lat lng,lat ...". Returns [{lat,lng},...].
            const tokens = kmlString.trim().split(/\s+/);
            const path = [];
            for (let i = 0; i < tokens.length; i++) {
                const parts = tokens[i].split(',');
                if (parts.length < 2) continue;
                const lng = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                if (!isNaN(lat) && !isNaN(lng)) path.push({ lat: lat, lng: lng });
            }
            return path;
        }

        // Builds ONE google.maps.GroundOverlay containing all Solapur village labels
        // pre-rendered into a single canvas. Collapsing 26 overlays to 1 is what makes
        // Solapur zoom smooth — each GroundOverlay costs a CSS transform reproject per
        // frame of the zoom animation, and 26 of them compound noticeably.
        //
        // Text drawing (font, stroke, padding, line height, baseline formula, rotation
        // direction) matches the Android source of truth byte-for-byte, just translated
        // to consolidated-canvas coordinates via a per-label design-unit → pixel factor.
        function buildSolapurLabelsConsolidatedOverlay(labels) {
            if (!labels || !labels.length) return null;

            // 1. Label center bbox, padded by the widest label's extent.
            let minLat = Infinity, maxLat = -Infinity;
            let minLng = Infinity, maxLng = -Infinity;
            let maxLabelMeters = 0;
            labels.forEach(function(l) {
                if (l.lat < minLat) minLat = l.lat;
                if (l.lat > maxLat) maxLat = l.lat;
                if (l.lng < minLng) minLng = l.lng;
                if (l.lng > maxLng) maxLng = l.lng;
                const w = 1500 * (l.scale || 1);
                if (w > maxLabelMeters) maxLabelMeters = w;
            });
            const latMid = (minLat + maxLat) / 2;
            const mPerDegLat = 111320;
            const mPerDegLng = 111320 * Math.cos(latMid * Math.PI / 180);
            const padLat = maxLabelMeters / mPerDegLat;
            const padLng = maxLabelMeters / mPerDegLng;
            minLat -= padLat; maxLat += padLat;
            minLng -= padLng; maxLng += padLng;
            const bboxW_m = (maxLng - minLng) * mPerDegLng;
            const bboxH_m = (maxLat - minLat) * mPerDegLat;

            // 2. Canvas sized so the longer side = 4096 px (~5 m/px at ~20 km bbox).
            const MAX_SIDE_PX = 4096;
            let canvasW, canvasH;
            if (bboxW_m >= bboxH_m) {
                canvasW = MAX_SIDE_PX;
                canvasH = Math.max(2, Math.round(MAX_SIDE_PX * bboxH_m / bboxW_m));
            } else {
                canvasH = MAX_SIDE_PX;
                canvasW = Math.max(2, Math.round(MAX_SIDE_PX * bboxW_m / bboxH_m));
            }
            const pxPerMeter = canvasW / bboxW_m;

            const canvas = document.createElement('canvas');
            canvas.width = canvasW;
            canvas.height = canvasH;
            const ctx = canvas.getContext('2d');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#FFFFFF';
            ctx.strokeStyle = '#000000';
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;

            // 3. Draw each label at its world position, rotated in-place.
            const FONT_SIZE = 100;
            const LINE_H = 120;
            const PAD_X = 24;
            const PAD_Y = 20;

            labels.forEach(function(lbl) {
                const text = String(lbl.text || '');
                const lines = text.split('\n');
                const maxChars = lines.reduce(function(m, l) { return Math.max(m, l.length); }, 0);
                const vbW = Math.max(160, Math.round(maxChars * FONT_SIZE * 0.58) + PAD_X * 2);
                const vbH = lines.length * LINE_H + PAD_Y * 2;
                const widthMeters = 1500 * (lbl.scale || 1);

                // design unit → meter = widthMeters / vbW; meter → canvas px = pxPerMeter.
                const designToPx = (widthMeters / vbW) * pxPerMeter;

                const cx_m = (lbl.lng - minLng) * mPerDegLng;
                const cy_m = (maxLat - lbl.lat) * mPerDegLat;
                const cx_px = cx_m * pxPerMeter;
                const cy_px = cy_m * pxPerMeter;

                ctx.save();
                ctx.translate(cx_px, cy_px);
                if (lbl.rotation) ctx.rotate(lbl.rotation * Math.PI / 180);

                ctx.font = '700 ' + (FONT_SIZE * designToPx) + 'px sans-serif';
                ctx.lineWidth = FONT_SIZE * 0.22 * designToPx;

                for (let i = 0; i < lines.length; i++) {
                    const yDesign = (PAD_Y + LINE_H * (i + 0.82)) - vbH / 2;
                    const y = yDesign * designToPx;
                    ctx.strokeText(lines[i], 0, y);
                    ctx.fillText(lines[i], 0, y);
                }

                ctx.restore();
            });

            const dataUrl = canvas.toDataURL('image/png');
            const bounds = { north: maxLat, south: minLat, east: maxLng, west: minLng };
            return new google.maps.GroundOverlay(dataUrl, bounds, {
                clickable: false,
                opacity: 1
            });
        }

        // Bump when data/solapur_overlay.json changes — invalidates the localStorage cache.
        const SOLAPUR_OVERLAY_CACHE_KEY = 'solapur_overlay_v1';

        async function loadSolapurOverlayIfNeeded() {
            if (solapurOverlayLoadStarted || !map) return;
            solapurOverlayLoadStarted = true;
            try {
                let data = null;
                try {
                    const raw = localStorage.getItem(SOLAPUR_OVERLAY_CACHE_KEY);
                    if (raw) data = JSON.parse(raw);
                } catch (e) { /* ignore corrupt cache */ }
                if (!data) {
                    const resp = await fetch('data/solapur_overlay.json');
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    data = await resp.json();
                    try {
                        localStorage.setItem(SOLAPUR_OVERLAY_CACHE_KEY, JSON.stringify(data));
                    } catch (e) { /* quota */ }
                }

                // 1. Labels → ONE consolidated google.maps.GroundOverlay (all 26 villages
                //    pre-rendered into a single canvas — see buildSolapurLabelsConsolidatedOverlay
                //    above for why 26→1 is what makes Solapur zoom smooth).
                if ((data.labels || []).length) {
                    const ov = buildSolapurLabelsConsolidatedOverlay(data.labels);
                    if (ov) {
                        ov.setMap(map);
                        solapurLabelOverlays.push(ov);
                    }
                }

                // 2. TP Scheme boundaries → thin solid white polylines.
                // (Was: repeated SVG symbol "dash" icons at 16px repeat — Google Maps had
                // to reposition thousands of symbol instances every zoom frame, which was
                // the main cause of Solapur zoom lag.)
                (data.tpSchemeKml || []).forEach(function(kml) {
                    const path = _parseKmlPolyline(kml);
                    if (path.length < 2) return;
                    const pl = new google.maps.Polyline({
                        path: path,
                        strokeColor: '#FFFFFF',
                        strokeOpacity: 0.85,
                        strokeWeight: 2,
                        clickable: false,
                        zIndex: 20000,
                        map: map
                    });
                    solapurTpSchemeLines.push(pl);
                });

                solapurOverlayLoaded = true;
                updateSolapurLabelOpacity(map.getZoom());
            } catch (e) {
                console.warn('Solapur overlay load failed:', e);
                solapurOverlayLoadStarted = false; // allow a future retry
            }
        }

        function updateSolapurLabelOpacity(zoom) {
            if (!solapurOverlayLoaded) return;
            let opacity;
            if (zoom >= SOLAPUR_HIDE_ZOOM) {
                opacity = 0;
            } else if (zoom <= SOLAPUR_FADE_MIN_ZOOM) {
                opacity = 1;
            } else {
                // Quadratic ease-out: opacity = HIDE + (1 - HIDE) * (1 - t)^2
                // Steep slope near t=0 (z just past 12), flat slope near t=1 (z near 18).
                const t = (zoom - SOLAPUR_FADE_MIN_ZOOM) / (SOLAPUR_HIDE_ZOOM - SOLAPUR_FADE_MIN_ZOOM);
                const u = 1 - t;
                opacity = SOLAPUR_HIDE_OPACITY + (1 - SOLAPUR_HIDE_OPACITY) * u * u;
            }
            for (let i = 0; i < solapurLabelOverlays.length; i++) {
                solapurLabelOverlays[i].setOpacity(opacity);
            }
        }

        function maybeLoadSolapurOverlay() {
            if (!isVillageBoundaryEnabled) return;
            if (solapurOverlayLoadStarted || !map) return;
            const vp = map.getBounds();
            if (!vp) return;
            const sd = GEOJSON_DISTRICT_INDEX.find(function(d) { return d.file === 'solapur'; });
            if (!sd) return;
            const vpN = vp.getNorthEast().lat(), vpS = vp.getSouthWest().lat();
            const vpE = vp.getNorthEast().lng(), vpW = vp.getSouthWest().lng();
            if (sd.s <= vpN && sd.n >= vpS && sd.w <= vpE && sd.e >= vpW) {
                loadSolapurOverlayIfNeeded();
            }
        }

        // ---------- Viewport-based district loading ----------
        let _geojsonViewportDebounce = null;
        function loadGeoJsonForViewport() {
            if (!isVillageBoundaryEnabled) return;
            if (!map) return;
            if (!tilesInitiated) return; // Defer GeoJSON until tiles are initiated
            if (map.getZoom() < MIN_ZOOM_FOR_GEOJSON) {
                if (renderedDistricts.size > 0) _removeAllVillagePolylines();
                return;
            }
            clearTimeout(_geojsonViewportDebounce);
            _geojsonViewportDebounce = setTimeout(_doLoadGeoJsonForViewport, 150);
        }
        async function _doLoadGeoJsonForViewport() {
            if (!map) return;
            if (map.getZoom() < MIN_ZOOM_FOR_GEOJSON) return;
            // Defensive: cold-cache loads may not have GEOJSON_DISTRICT_INDEX
            // populated yet. Loader is idempotent, so this is a no-op once warm.
            if (GEOJSON_DISTRICT_INDEX.length === 0) await loadDistrictBboxIndex();
            const vp = map.getBounds();
            if (!vp) return;
            const vpN = vp.getNorthEast().lat(), vpS = vp.getSouthWest().lat();
            const vpE = vp.getNorthEast().lng(), vpW = vp.getSouthWest().lng();

            // 1. Find districts whose bounds intersect the viewport
            const visibleFiles = new Set();
            for (const d of GEOJSON_DISTRICT_INDEX) {
                if (d.s <= vpN && d.n >= vpS && d.w <= vpE && d.e >= vpW) {
                    visibleFiles.add(d.file);
                }
            }

            // 2. Remove districts no longer in viewport
            for (const [file, entry] of renderedDistricts) {
                if (!visibleFiles.has(file)) {
                    for (const arr of entry.polylineMap.values()) {
                        for (const pl of arr) pl.setMap(null);
                    }
                    renderedDistricts.delete(file);
                }
            }

            // 3. Download & render newly visible districts
            for (const file of visibleFiles) {
                if (renderedDistricts.has(file)) continue;
                const idx = GEOJSON_DISTRICT_INDEX.find(d => d.file === file);
                const name = idx ? idx.name : file;
                renderedDistricts.set(file, {
                    districtName: name, villages: [], colorIndex: 0,
                    polylineMap: new Map(), loading: true
                });
                _loadAndRenderDistrict(file, name);
            }
        }
        async function _loadAndRenderDistrict(file, districtName) {
            try {
                const villages = await loadDistrictGeoJson(file);
                // Assign color: check IDB for existing, else use next in sequence
                const distRec = await getDistrict(file);
                let colorIndex;
                if (distRec && typeof distRec.colorIndex === 'number') {
                    colorIndex = distRec.colorIndex;
                } else {
                    colorIndex = _nextDistrictColorIndex;
                    _nextDistrictColorIndex = (_nextDistrictColorIndex + 1) % GEOJSON_DISTRICT_COLORS.length;
                    // Persist colorIndex
                    if (distRec) {
                        distRec.colorIndex = colorIndex;
                        await putDistrict(distRec);
                    }
                }
                // Check if still in renderedDistricts (user may have panned away)
                const entry = renderedDistricts.get(file);
                if (!entry) return;
                entry.villages = villages;
                entry.colorIndex = colorIndex;
                entry.loading = false;
                updateVillagePolylines();
            } catch (e) {
                console.warn('[geojson] load failed for', file, '—', e.message);
                renderedDistricts.delete(file);
            }
        }

        // Get reference to Firebase database
        const database = firebase.database();

        // Debounce: wait 200ms after last viewport change (matches Android's 200ms debounce)
        let debounceTimeout = null;

        function debouncedLoadTiles() {
            if (debounceTimeout) clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => {
                loadTilesBasedOnViewport();
                debounceTimeout = null;
            }, 200);
        }

        // --- Web Worker: all polygon math runs off the main thread ---
        // Resolve the Flatbush URL relative to the document, then bake it into
        // the worker source as a JSON-escaped literal so importScripts inside
        // the blob worker can pull it from the page's origin. If Flatbush
        // fails to load (CSP, offline, etc.) the worker silently falls back
        // to a linear scan — same behavior as before Phase 1.
        const _flatbushUrlForWorker = new URL('AssetsGIS/flatbush.js', location.href).href;
        const workerCode = `
            try { importScripts(${JSON.stringify(_flatbushUrlForWorker)}); } catch (e) { /* fallback: linear scan */ }

            function pointInPolygon(point, polygon) {
                let inside = false;
                for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                    const xi = polygon[i].lng, yi = polygon[i].lat;
                    const xj = polygon[j].lng, yj = polygon[j].lat;
                    const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
                        (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
                    if (intersect) inside = !inside;
                }
                return inside;
            }

            function isAnyVertexInView(polygon, vp) {
                for (let i = 0; i < polygon.length; i++) {
                    const v = polygon[i];
                    if (v.lat >= vp.minLat && v.lat <= vp.maxLat &&
                        v.lng >= vp.minLng && v.lng <= vp.maxLng) return true;
                }
                return false;
            }

            function lineSegmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
                if (Math.max(x1,x2) < Math.min(x3,x4) || Math.max(x3,x4) < Math.min(x1,x2) ||
                    Math.max(y1,y2) < Math.min(y3,y4) || Math.max(y3,y4) < Math.min(y1,y2)) return false;
                const det = (x2-x1)*(y4-y3) - (x4-x3)*(y2-y1);
                if (Math.abs(det) < 1e-10) return false;
                const t = ((x3-x1)*(y4-y3) - (x4-x3)*(y3-y1)) / det;
                const u = -((x2-x1)*(y3-y1) - (x2-x3)*(y2-y1)) / det;
                return t >= 0 && t <= 1 && u >= 0 && u <= 1;
            }

            function doesPolygonIntersectBounds(polygon, vp) {
                const bl = [
                    { x1:vp.minLat,y1:vp.minLng,x2:vp.maxLat,y2:vp.minLng },
                    { x1:vp.maxLat,y1:vp.minLng,x2:vp.maxLat,y2:vp.maxLng },
                    { x1:vp.maxLat,y1:vp.maxLng,x2:vp.minLat,y2:vp.maxLng },
                    { x1:vp.minLat,y1:vp.maxLng,x2:vp.minLat,y2:vp.minLng }
                ];
                for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                    const s = polygon[j], e = polygon[i];
                    const eMinLat = s.lat < e.lat ? s.lat : e.lat;
                    const eMaxLat = s.lat > e.lat ? s.lat : e.lat;
                    const eMinLng = s.lng < e.lng ? s.lng : e.lng;
                    const eMaxLng = s.lng > e.lng ? s.lng : e.lng;
                    if (eMinLat > vp.maxLat || eMaxLat < vp.minLat ||
                        eMinLng > vp.maxLng || eMaxLng < vp.minLng) continue;
                    for (const b of bl) {
                        if (lineSegmentsIntersect(s.lat,s.lng,e.lat,e.lng,b.x1,b.y1,b.x2,b.y2)) return true;
                    }
                }
                return pointInPolygon({lat:(vp.minLat+vp.maxLat)/2, lng:(vp.minLng+vp.maxLng)/2}, polygon);
            }

            function shouldLoadTile(layerDef, currentZoom, centerPoint, vp, zoomLimits) {
                const minZoom = layerDef.minZoom || zoomLimits[0];
                const maxZoom = layerDef.maxZoom || zoomLimits[1];
                if (currentZoom < minZoom || currentZoom > maxZoom) return false;
                const bbox = layerDef.bbox;
                if (bbox && (bbox.minLat > vp.maxLat || bbox.maxLat < vp.minLat ||
                    bbox.minLng > vp.maxLng || bbox.maxLng < vp.minLng)) return false;
                const polygon = layerDef.polygon;
                if (!polygon) return false;
                return pointInPolygon(centerPoint, polygon) ||
                    isAnyVertexInView(polygon, vp) ||
                    doesPolygonIntersectBounds(polygon, vp);
            }

            // Layer data is cached inside the worker to avoid structured-cloning
            // the full ~576 KB village polygon set on every 200 ms pan. Main thread
            // pushes data once via { kind:'loadLayer' } (and again if the backing
            // array reference changes — e.g. a cache-version refetch). Subsequent
            // 'compute' messages carry only viewport + active types.
            //
            // Phase 1: loadLayer may also carry a Flatbush index (indexBuffer +
            // indexIdxMap) — when present we use index.search to narrow the
            // compute loop from O(N) to O(log N + K). Absent index → linear scan.
            const layerCache = {};

            self.onmessage = function(e) {
                const msg = e.data;
                if (msg.kind === 'loadLayer') {
                    const cached = { data: msg.data, index: null, idxMap: null };
                    if (msg.indexBuffer && msg.indexIdxMap && typeof Flatbush !== 'undefined') {
                        try {
                            cached.index = Flatbush.from(msg.indexBuffer);
                            cached.idxMap = new Int32Array(msg.indexIdxMap);
                        } catch (err) { /* fallback to linear scan */ }
                    }
                    layerCache[msg.type] = cached;
                    return;
                }
                // kind: 'compute'
                const { generation, activeTypes, currentZoom, centerPoint, vp } = msg;
                const results = {};
                for (let k = 0; k < activeTypes.length; k++) {
                    const at = activeTypes[k];
                    const cached = layerCache[at.type];
                    if (!cached) continue;
                    const data = cached.data;
                    const decisions = new Array(data.length);
                    for (let i = 0; i < data.length; i++) decisions[i] = false;
                    if (cached.index) {
                        const hits = cached.index.search(vp.minLng, vp.minLat, vp.maxLng, vp.maxLat);
                        const map = cached.idxMap;
                        for (let h = 0; h < hits.length; h++) {
                            const i = map[hits[h]];
                            decisions[i] = shouldLoadTile(data[i], currentZoom, centerPoint, vp, at.zoomLimits);
                        }
                    } else {
                        for (let i = 0; i < data.length; i++) {
                            decisions[i] = shouldLoadTile(data[i], currentZoom, centerPoint, vp, at.zoomLimits);
                        }
                    }
                    results[at.type] = decisions;
                }
                self.postMessage({ generation, results });
            };
        `;
        const tileWorker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));

        // Tracks which array reference has already been pushed to the worker's
        // layerCache. Identity comparison — a cache-version refetch assigns a
        // fresh array to dpLayerData/villageLayerData/oldDPLayerData, which
        // triggers an automatic resend on the next loadTilesBasedOnViewport.
        const _workerSentRefs = { dp: null, village: null, oldDP: null };

        // Zoom limits per layer type
        const ZOOM_LIMITS = {
            dp: [MIN_ZOOM_FOR_DP, MAX_ZOOM_FOR_DP],
            village: [MIN_ZOOM_FOR_VILLAGEMAP, MAX_ZOOM_FOR_VILLAGEMAP],
            oldDP: [MIN_ZOOM_FOR_OLD_DP, MAX_ZOOM_FOR_OLD_DP]
        };

        // Analytics: track how long each DP district has been continuously visible.
        // Emit `district_viewed` once per district per session after >=3s of continuous visibility.
        var _mmDistrictVisibleSince = {}; // id -> firstSeenTs
        var _mmDistrictReported = {};     // id -> true (once-per-session)
        function _mmTrackDistrictVisibility(decisions, layerData) {
            try {
                var now = Date.now();
                var seen = {};
                for (var i = 0; i < decisions.length; i++) {
                    if (decisions[i] && layerData[i]) {
                        var id = layerData[i].id;
                        seen[id] = true;
                        if (!_mmDistrictVisibleSince[id]) _mmDistrictVisibleSince[id] = now;
                        if (!_mmDistrictReported[id] && (now - _mmDistrictVisibleSince[id]) >= 3000) {
                            _mmDistrictReported[id] = true;
                            mmAnalytics.event('district_viewed', {
                                district_id: String(id).slice(0, 60),
                                pid: String(layerData[i].productPurchaseID || '').slice(0, 60)
                            });
                        }
                    }
                }
                // Reset visibility timer for districts that left viewport
                for (var k in _mmDistrictVisibleSince) {
                    if (!seen[k]) delete _mmDistrictVisibleSince[k];
                }
            } catch (e) {}
        }

        // Worker sends results back -- apply on main thread (fast: just show/hide overlays)
        tileWorker.onmessage = function(e) {
            const { generation, results } = e.data;

            // CANCEL stale results: if user has zoomed/panned since, discard
            if (generation !== currentGeneration) return;

            // Analytics: track DP-district visibility (the primary product context)
            if (results.dp) _mmTrackDistrictVisibility(results.dp, dpLayerData);

            // Apply decisions for each layer
            if (results.dp) applyTileDecisions(results.dp, dpLayerData, dpTileStatus, dpOverlays, "dp");
            if (results.village) {
                // Only load village tiles for purchased villages
                var filteredVillage = results.village.map(function(show, i) {
                    if (!show) return false;
                    var vName = villageLayerData[i] && villageLayerData[i].villageName;
                    return vName && hasVillagePurchase(vName);
                });
                applyTileDecisions(filteredVillage, villageLayerData, villageTileStatus, villageOverlays, "village");
            }
            if (results.oldDP) applyTileDecisions(results.oldDP, oldDPLayerData, oldDPTileStatus, oldDPOverlays, "oldDP");
        };

        function applyTileDecisions(decisions, layerData, tileStatus, overlayMap, layerType) {
            // Unload first (frees HTTP connections for new tiles)
            for (let i = 0; i < decisions.length; i++) {
                if (!decisions[i] && tileStatus[i]) {
                    unloadTileOverlay(layerData[i].id, overlayMap);
                    tileStatus[i] = false;
                }
            }
            // Then load
            for (let i = 0; i < decisions.length; i++) {
                if (decisions[i] && !tileStatus[i]) {
                    loadTileOverlay(layerData[i], layerType, overlayMap);
                    tileStatus[i] = true;
                }
            }
        }
        
        // Initialize the map when the Google Maps API is loaded
        function initMap() {
            var als = document.getElementById('app-loading-status');
            if (als) als.textContent = 'Initializing map...';
            updateStatus("Initializing map...");

            // Restore color counter from any previously-cached districts
            getAllDistricts().then(all => {
                if (all && all.length > 0) {
                    let maxIdx = -1;
                    for (const d of all) {
                        if (typeof d.colorIndex === 'number' && d.colorIndex > maxIdx) maxIdx = d.colorIndex;
                    }
                    if (maxIdx >= 0) _nextDistrictColorIndex = (maxIdx + 1) % GEOJSON_DISTRICT_COLORS.length;
                }
            }).catch(() => {});

            // URL parameter support for embedding and deep-linking
            const urlParams = new URLSearchParams(window.location.search);
            const paramLat = parseFloat(urlParams.get('lat'));
            const paramLng = parseFloat(urlParams.get('lng'));
            const paramZoom = parseInt(urlParams.get('zoom'), 10);

            // Last-position memory: restore center + zoom from the previous session.
            // URL params win over this (explicit deep-link), which in turn wins over the
            // hardcoded Mumbai default.
            const LAST_MAP_POS_KEY = 'mm_lastMapPosition_v1';
            let savedLat = NaN, savedLng = NaN, savedZoom = NaN;
            try {
                const raw = localStorage.getItem(LAST_MAP_POS_KEY);
                if (raw) {
                    const p = JSON.parse(raw);
                    if (p && typeof p.lat === 'number' && typeof p.lng === 'number' && typeof p.zoom === 'number'
                        && p.lat >= -90 && p.lat <= 90
                        && p.lng >= -180 && p.lng <= 180
                        && p.zoom >= 0 && p.zoom <= 24) {
                        savedLat = p.lat; savedLng = p.lng; savedZoom = p.zoom;
                    }
                }
            } catch (e) { /* localStorage unavailable or JSON parse failed — fall through */ }

            const initLat = !isNaN(paramLat) ? paramLat : (!isNaN(savedLat) ? savedLat : 18.93742);
            const initLng = !isNaN(paramLng) ? paramLng : (!isNaN(savedLng) ? savedLng : 72.82810);
            const initZoom = !isNaN(paramZoom) ? paramZoom : (!isNaN(savedZoom) ? savedZoom : 13);

            if (isEmbedMode) {
                document.body.classList.add('embed-mode');
            }

            // TODO: Migrate google.maps.Marker → AdvancedMarkerElement when Google fixes Vector+HYBRID CORS issue.
            // As of 2026-04, Vector maps + HYBRID mapType causes 403 CORS errors on satellite tiles (webgl.js).
            // Map ID: '205cba59b6ab439c17e54bd1' (created in Cloud Console, ready to use)
            // Migration checklist:
            //   1. Add mapId to Map constructor, add 'marker' to libraries, set isFractionalZoomEnabled:false
            //   2. Replace all new google.maps.Marker(...) with new google.maps.marker.AdvancedMarkerElement(...)
            //   3. icon → content (DOM element), draggable → gmpDraggable, addListener → addEventListener(gmp-*)
            //   4. .setPosition() → .position=, .getPosition() → .position, .setMap(null) → .map=null
            //   5. .setIcon() → .content=, getVillageMarkerIcon must return DOM element not {url,scaledSize,anchor}
            //   6. Test: satellite tiles load without CORS errors, all markers render, drag/click events work
            map = new google.maps.Map(document.getElementById('map'), {
                center: { lat: initLat, lng: initLng },
                zoom: initZoom,
                mapTypeId: google.maps.MapTypeId.HYBRID,
                streetViewControl: false,
                mapTypeControl: false,
                zoomControl: !isEmbedMode,
                zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
                fullscreenControl: false,
                gestureHandling: isEmbedMode ? 'none' : 'greedy',
                // Suppress Google's POI hit-testing and icon rendering — we don't use
                // place clicks, and it's a documented pan-jank source on low-end Android.
                clickableIcons: false,
                maxZoom: MAX_FREE_ZOOM
            });

            // Safety: if tiles haven't initiated after 15s, unblock GeoJSON anyway
            setTimeout(function() {
                if (!tilesInitiated) {
                    tilesInitiated = true;
                    loadGeoJsonForViewport();
                }
            }, 15000);

            // Replace native right-click menu on map with a custom "Copy coordinates" menu.
            // Also closes the right-click -> Save image as... path for tile imagery.
            (function setupMapContextMenu() {
                var menuEl   = document.getElementById('map-ctx-menu');
                var coordEl  = document.getElementById('map-ctx-menu-coord');
                var copyBtn  = document.getElementById('map-ctx-menu-copy');
                var shareBtn = document.getElementById('map-ctx-menu-share');
                var currentCoord = '';
                var currentLat = 0, currentLng = 0;

                function hideMenu() { menuEl.classList.remove('visible'); }
                function showMenuAt(clientX, clientY, latLng) {
                    currentLat = latLng.lat();
                    currentLng = latLng.lng();
                    currentCoord = currentLat.toFixed(5) + ', ' + currentLng.toFixed(5);
                    coordEl.textContent = currentCoord;
                    // Clamp to viewport so the menu is never clipped off-screen.
                    menuEl.style.left = Math.min(clientX, window.innerWidth  - 220) + 'px';
                    menuEl.style.top  = Math.min(clientY, window.innerHeight - 120) + 'px';
                    menuEl.classList.add('visible');
                }

                // Google Maps 'contextmenu' event gives us latLng + the underlying DOM event.
                map.addListener('contextmenu', function(e) {
                    if (e.domEvent) e.domEvent.preventDefault();
                    showMenuAt(e.domEvent.clientX, e.domEvent.clientY, e.latLng);
                });

                // Copy to clipboard. navigator.clipboard requires https or localhost.
                copyBtn.addEventListener('click', function() {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(currentCoord).catch(function(){});
                    } else {
                        // Fallback for older browsers / non-secure contexts.
                        var ta = document.createElement('textarea');
                        ta.value = currentCoord;
                        document.body.appendChild(ta);
                        ta.select();
                        try { document.execCommand('copy'); } catch (err) {}
                        document.body.removeChild(ta);
                    }
                    hideMenu();
                });

                // Share location — opens OS-native share sheet on Android/iOS/Windows where
                // supported (navigator.share), falls back to clipboard + toast otherwise.
                // URL format is the same one maps.html already parses on load
                // (?lat=X&lng=Y&zoom=Z), so the recipient opens straight to this spot.
                function showShareToast(text) {
                    var toast = document.getElementById('unlock-toast');
                    var toastText = document.getElementById('unlock-toast-text');
                    if (!toast || !toastText) return;
                    toastText.textContent = text;
                    toast.classList.add('show');
                    setTimeout(function(){ toast.classList.remove('show'); }, 2400);
                }
                function buildShareUrl() {
                    var zoom = (typeof map !== 'undefined' && map.getZoom) ? map.getZoom() : 15;
                    var base = window.location.origin + window.location.pathname;
                    return base + '?lat=' + currentLat.toFixed(6) + '&lng=' + currentLng.toFixed(6) + '&zoom=' + zoom;
                }
                shareBtn.addEventListener('click', function() {
                    hideMenu();
                    var url = buildShareUrl();
                    var shareData = {
                        title: 'MapMagician — shared location',
                        text: 'Location on MapMagician: ' + currentCoord,
                        url: url
                    };
                    if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
                        navigator.share(shareData).catch(function(){ /* user cancelled or share failed */ });
                    } else if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(url).then(function(){
                            showShareToast('Link copied to clipboard');
                        }).catch(function(){
                            showShareToast('Copy failed');
                        });
                    } else {
                        var ta = document.createElement('textarea');
                        ta.value = url;
                        document.body.appendChild(ta);
                        ta.select();
                        try {
                            document.execCommand('copy');
                            showShareToast('Link copied to clipboard');
                        } catch (err) {
                            showShareToast('Unable to copy');
                        }
                        document.body.removeChild(ta);
                    }
                });

                // Dismiss menu on any outside click or Escape.
                document.addEventListener('click', function(e) {
                    if (!menuEl.contains(e.target)) hideMenu();
                });
                document.addEventListener('keydown', function(e) {
                    if (e.key === 'Escape') hideMenu();
                });
                map.addListener('dragstart', hideMenu);
                map.addListener('zoom_changed', hideMenu);
            })();

            // Suppress native context menu on the magnifier loupe (transient, no custom menu needed).
            var magEl = document.getElementById('magnifier-map');
            if (magEl) magEl.addEventListener('contextmenu', function(e) { e.preventDefault(); });

            // Block drag-to-desktop on tile images in both containers.
            ['map', 'magnifier-map'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.addEventListener('dragstart', function(e) { e.preventDefault(); });
            });

            // Block Ctrl+S / Cmd+S keystroke. Does NOT block File menu -> Save As.
            window.addEventListener('keydown', function(e) {
                if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, true);

            // Global contextmenu block: suppresses native browser menu ("Save Page As...",
            // "Save Image As...") on every element. Text inputs are whitelisted so users
            // can still right-click paste. The map has its own custom "Copy coordinates"
            // menu handled via map.addListener('contextmenu') above.
            document.addEventListener('contextmenu', function(e) {
                var t = e.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
                    return; // allow native menu on editable fields
                }
                e.preventDefault();
            });

            // Places Autocomplete (New API)
            // Google Places — new API (Place class)

            // Analytics: map_ready (first idle) + debounced map_pan on subsequent idles
            var _mmMapReady = false;
            var _mmLastCenter = null;
            var _mmLastZoom = null;
            var _mmPanDebounce = null;
            function _mmDistanceKm(a, b) {
                if (!a || !b) return 0;
                var R = 6371;
                var dLat = (b.lat - a.lat) * Math.PI / 180;
                var dLng = (b.lng - a.lng) * Math.PI / 180;
                var s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
                var h = s1*s1 + Math.cos(a.lat*Math.PI/180) * Math.cos(b.lat*Math.PI/180) * s2*s2;
                return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
            }
            // Single debounced handler for all viewport changes
            map.addListener('idle', function() {
                const z = map.getZoom();
                const c = map.getCenter();
                document.getElementById('zoom-level').textContent = `Z=${z}`;
                document.getElementById('center-coord').textContent =
                    `${c.lat().toFixed(5)}, ${c.lng().toFixed(5)}`;
                // Analytics: map_ready (once) + throttled map_pan (2s debounce)
                try {
                    if (!_mmMapReady) {
                        _mmMapReady = true;
                        mmAnalytics.event('map_ready', { zoom: z });
                        // Set initial state for village boundary toggle
                        var _vbCheckbox = document.getElementById('village-boundary-layer');
                        if (_vbCheckbox) _vbCheckbox.checked = isVillageBoundaryEnabled;
                    }
                    var curr = { lat: c.lat(), lng: c.lng() };
                    var prev = _mmLastCenter;
                    _mmLastCenter = curr;
                    if (_mmPanDebounce) clearTimeout(_mmPanDebounce);
                    _mmPanDebounce = setTimeout(function() {
                        var dist = _mmDistanceKm(prev, curr);
                        if (dist > 0.05) {
                            mmAnalytics.event('map_pan', {
                                distance_km: Math.round(dist * 100) / 100,
                                zoom: z,
                                lat: Math.round(curr.lat * 1000) / 1000,
                                lng: Math.round(curr.lng * 1000) / 1000
                            });
                        }
                    }, 2000);
                } catch (e) {}
                debouncedLoadTiles();
                // Update region subscription status in bottom bar
                updateRegionStatus();
                // Show/hide old maps button based on current region
                updateOldMapsButtonVisibility();
                // Warn user when current zoom exceeds the maxZoom of every active overlay covering the center
                checkOverlayZoomLimit(z, c);
                // PERF (perf #2 of next round): updateVillagePolylines() removed
                // from the per-idle path. Google Maps already calls
                // VillageBoundaryOverlay.draw() automatically on every viewport
                // change, and the function's only effect was to call
                // requestRedraw() — which manually re-fires the same draw().
                // We were drawing the canvas TWICE per pan. The function still
                // exists and is still called from _loadAndRenderDistrict.then
                // when new district data lands (where Google Maps wouldn't know
                // to redraw on its own).
                // Primary geojson loader: geocode current center → fetch district zip
                loadGeoJsonForViewport();
                // Show/hide village markers based on zoom
                updateVillageMarkerVisibility();
                // Lazy-load Solapur decorative overlay when its bounds come into view
                maybeLoadSolapurOverlay();
                // Keep Solapur label opacity in sync with current zoom
                updateSolapurLabelOpacity(z);
                // Show/hide village boundary toggle based on district availability
                var _vbToggle = document.getElementById('village-boundary-toggle');
                if (_vbToggle) {
                    var _hasGeoJson = false;
                    var _vp = map.getBounds();
                    if (_vp && z >= MIN_ZOOM_FOR_GEOJSON) {
                        var _vpN = _vp.getNorthEast().lat(), _vpS = _vp.getSouthWest().lat();
                        var _vpE = _vp.getNorthEast().lng(), _vpW = _vp.getSouthWest().lng();
                        for (var _di = 0; _di < GEOJSON_DISTRICT_INDEX.length; _di++) {
                            var _dd = GEOJSON_DISTRICT_INDEX[_di];
                            if (_dd.s <= _vpN && _dd.n >= _vpS && _dd.w <= _vpE && _dd.e >= _vpW) {
                                _hasGeoJson = true; break;
                            }
                        }
                    }
                    _vbToggle.style.display = _hasGeoJson ? '' : 'none';
                }
                // Persist last map position so the next visit opens at the same spot
                try {
                    localStorage.setItem(LAST_MAP_POS_KEY, JSON.stringify({
                        lat: c.lat(), lng: c.lng(), zoom: z
                    }));
                } catch (e) { /* quota exceeded / storage disabled — ignore */ }
            });
            map.addListener('bounds_changed', debouncedLoadTiles);

            // --- Hover region-name tooltip (desktop only) ---
            // At every zoom level, hovering a DP region shows a
            // cursor-following tooltip with the region name (no map highlight):
            // green for purchased, orange with a lock for unpurchased. Isolated from
            // the center-based paywall: writes only the _hover* vars below, never
            // sticky/district-cache state. mousemove never fires on touch, so mobile
            // is unaffected.
            let _hoverTooltipEl = null, _lastHoverPid = null;
            let _hoverRaf = 0, _hoverPendingEvt = null;
            // Last cursor screen position + over-map flag, so we can re-detect the
            // region under a stationary cursor while the map glides after a fling.
            let _lastClientX = 0, _lastClientY = 0, _cursorOverMap = false;
            let _hoverProjOverlay = null, _hoverRefreshRaf = 0;

            function _ensureHoverTooltip() {
                if (_hoverTooltipEl) return _hoverTooltipEl;
                _hoverTooltipEl = document.createElement('div');
                _hoverTooltipEl.className = 'dp-hover-tooltip';
                document.body.appendChild(_hoverTooltipEl);
                return _hoverTooltipEl;
            }
            function _clearHover() {
                if (_hoverTooltipEl) _hoverTooltipEl.style.display = 'none';
                _lastHoverPid = null;
            }
            function _positionHoverTooltip(cx, cy) {
                const el = _ensureHoverTooltip();
                let x = cx + 14, y = cy + 16;
                const w = el.offsetWidth || 160, h = el.offsetHeight || 28;
                if (x + w > window.innerWidth)  x = cx - w - 14;
                if (y + h > window.innerHeight) y = cy - h - 16;
                el.style.left = x + 'px';
                el.style.top = y + 'px';
            }
            function _processHoverMove() {
                _hoverRaf = 0;
                const e = _hoverPendingEvt; _hoverPendingEvt = null;
                if (!e || !map) return;
                if (!e.latLng) { _clearHover(); return; }
                const point = { lat: e.latLng.lat(), lng: e.latLng.lng() };
                const hit = findDpEntryAtPoint(point);
                if (!hit) { _clearHover(); return; }
                const pid = hit.district.productPurchaseID;
                if (pid !== _lastHoverPid) _showHoverTooltip(hit.district, pid);
                if (e.domEvent) _positionHoverTooltip(e.domEvent.clientX, e.domEvent.clientY);
            }
            // Set the tooltip text + colour for a region (text/colour change only on
            // region transition, guarded by the pid check at each call site).
            function _showHoverTooltip(district, pid) {
                _lastHoverPid = pid;
                const purchased = hasPurchase(pid);
                const name = district.districtName || '';
                const tip = _ensureHoverTooltip();
                tip.textContent = purchased ? name : ('🔒 ' + name); // 🔒 for locked
                tip.classList.toggle('purchased', purchased);
                tip.classList.toggle('locked', !purchased);
                tip.style.display = 'block';
            }
            // A bare OverlayView solely to expose the MapCanvasProjection, so we can
            // convert the last cursor pixel back to a lat/lng without a mouse move.
            function _ensureProjOverlay() {
                if (_hoverProjOverlay) return _hoverProjOverlay;
                _hoverProjOverlay = new google.maps.OverlayView();
                _hoverProjOverlay.onAdd = function() {};
                _hoverProjOverlay.draw = function() {};
                _hoverProjOverlay.onRemove = function() {};
                _hoverProjOverlay.setMap(map);
                return _hoverProjOverlay;
            }
            // Re-detect the region under the (possibly stationary) cursor. Drives the
            // post-fling update: as the map glides/settles, the geo-point under the
            // fixed cursor pixel changes, so we reproject and refresh the label.
            function _refreshHoverAtCursor() {
                _hoverRefreshRaf = 0;
                if (!_cursorOverMap || !map) return;
                const proj = _ensureProjOverlay().getProjection();
                if (!proj) return;
                const rect = map.getDiv().getBoundingClientRect();
                const ll = proj.fromContainerPixelToLatLng(
                    new google.maps.Point(_lastClientX - rect.left, _lastClientY - rect.top));
                if (!ll) return;
                const hit = findDpEntryAtPoint({ lat: ll.lat(), lng: ll.lng() });
                if (!hit) { _clearHover(); return; }
                const pid = hit.district.productPurchaseID;
                if (pid !== _lastHoverPid) _showHoverTooltip(hit.district, pid);
            }
            // The zoom-focus point: where a wheel / double-click zoom is anchored. Google
            // pins scroll & dblclick zoom under the cursor, so the live cursor latLng IS the
            // focus. Returns {lat,lng} when the cursor is reliably over the map, else null —
            // mobile pinch (no cursor) and +/- buttons / programmatic zoom are center-anchored,
            // so the paywall falls back to map.getCenter() in that case. Reuses the same
            // cursor pixel (_lastClientX/Y) + projection overlay the hover tooltip uses, so the
            // paywall judges the exact region the hover label is already naming under the cursor.
            function getZoomFocusPoint() {
                if (!_cursorOverMap || !map) return null;
                const proj = _ensureProjOverlay().getProjection();
                if (!proj) return null;
                const rect = map.getDiv().getBoundingClientRect();
                const x = _lastClientX - rect.left, y = _lastClientY - rect.top;
                if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null; // stale / off-map
                const ll = proj.fromContainerPixelToLatLng(new google.maps.Point(x, y));
                return ll ? { lat: ll.lat(), lng: ll.lng() } : null;
            }
            // Paywall region detection that honours the zoom-FOCUS point (the cursor) rather
            // than the map center. Google anchors scroll-wheel / double-click zoom under the
            // cursor, so a zoom into a screen corner drifts the center onto a NEIGHBOURING
            // district — the old center-based lookup then charged for the wrong region (zoom
            // into Thane, asked to pay for Mira-Bhayandar). Detecting at the focus point judges
            // the region the user actually zoomed INTO and also removes the boundary flicker
            // (a symptom of that same center drift). Falls back to the center-based,
            // sticky-stabilised path when there is no reliable focus point — mobile pinch (no
            // cursor) and +/- buttons / programmatic zoom are center-anchored anyway. Lives in
            // this (hover) scope so it can reach getZoomFocusPoint; findDpEntryAtPoint,
            // findDistrictAtCenterCached and stickyTile/stickyDistrict are visible from the
            // enclosing scope.
            function findDistrictAtFocusOrCenter() {
                const fp = getZoomFocusPoint();
                if (fp) {
                    const hit = findDpEntryAtPoint(fp);
                    if (hit) {
                        // Keep sticky aligned with the focus result so the region-mismatch
                        // dialog, bottom-bar status and the post-unlock reset all agree.
                        stickyTile = hit.entry;
                        stickyDistrict = hit.district;
                        return hit.district;
                    }
                    // Focus hit no DP polygon (cursor over a gap/sea): fall through to center
                    // so we don't spuriously flash "No Data" — that's data-vs-nodata, not the
                    // owned-vs-unpurchased boundary the strict focus policy governs.
                }
                return findDistrictAtCenterCached();
            }
            function _scheduleHoverRefresh() {
                if (!_hoverRefreshRaf) _hoverRefreshRaf = requestAnimationFrame(_refreshHoverAtCursor);
            }
            map.addListener('mousemove', function(e) {
                // Tooltip follows every raw move (cheap); region recompute is rAF-throttled.
                if (_lastHoverPid && e.domEvent) _positionHoverTooltip(e.domEvent.clientX, e.domEvent.clientY);
                _hoverPendingEvt = e;
                if (!_hoverRaf) _hoverRaf = requestAnimationFrame(_processHoverMove);
            });
            // Google Maps' 'mousemove' stops firing during a drag-pan, which would
            // freeze the tooltip in place. The raw DOM mousemove still fires; the
            // grabbed geo-point is pinned under the cursor while panning, so the
            // region name stays valid and we only need to keep repositioning.
            map.getDiv().addEventListener('mousemove', function(e) {
                _lastClientX = e.clientX; _lastClientY = e.clientY; _cursorOverMap = true;
                if (_lastHoverPid) _positionHoverTooltip(e.clientX, e.clientY);
            });
            map.getDiv().addEventListener('mouseleave', function() {
                _cursorOverMap = false;
                _clearHover();
            });
            // After a fling the map keeps gliding while the cursor sits still, so no
            // mousemove fires; re-detect the region under the cursor as the camera
            // moves (rAF-throttled) and once it settles.
            map.addListener('bounds_changed', _scheduleHoverRefresh);
            map.addListener('idle', _refreshHoverAtCursor);
            // Warm up the projection overlay now so it's ready before the first fling.
            _ensureProjOverlay();

            // Region detection on camera move (throttled 300ms, like Android)
            let lastRegionCheckTime = 0;
            map.addListener('center_changed', function() {
                const now = Date.now();
                if (now - lastRegionCheckTime < 300) return;
                lastRegionCheckTime = now;
                checkRegionOnMove();
            });

            // Analytics: map_zoom — debounced 1.5s so rapid scroll-wheel zoom fires once
            var _mmZoomDebounce = null;
            map.addListener('zoom_changed', function() {
                try {
                    var zNow = map.getZoom();
                    if (_mmZoomDebounce) clearTimeout(_mmZoomDebounce);
                    _mmZoomDebounce = setTimeout(function() {
                        var prev = _mmLastZoom;
                        _mmLastZoom = zNow;
                        mmAnalytics.event('map_zoom', {
                            from: prev || 0,
                            to: zNow,
                            bucket: zNow > 14 ? 'premium' : 'free'
                        });
                    }, 1500);
                } catch (e) {}
            });
            // Show purchase dialog when user hits zoom 14 in unpurchased region, hide when they zoom out
            map.addListener('zoom_changed', function() {
                // Fade Solapur decorative labels smoothly as the zoom changes
                updateSolapurLabelOpacity(map.getZoom());
                if (zoomBypassActive || mapInteractionDisabled) return;
                // Don't make any access decision until layer data is loaded —
                // otherwise a cold reload at a saved premium zoom flashes the
                // "No Map Data Available" dialog while MahaGIS.json is still landing.
                if (!dpDataLoaded || !villageDataLoaded) return;
                const z = map.getZoom();
                const overlay = document.getElementById('zoom-restrict-overlay');
                const district = findDistrictAtFocusOrCenter();

                if (z >= MAX_FREE_ZOOM && !district) {
                    // Check if we're in a village area — allow zoom for village purchase via markers
                    var villageHere = findVillageAtCenterCached();
                    if (villageHere) {
                        // In village area — unlock zoom so user can see markers and purchase.
                        // Uniform 21 ceiling (same as purchased-region paths) so each plan can be
                        // zoomed to its own DB MaxZoom; per-link tile gating in CanvasMapType.getTile
                        // stops actual tile fetches above each sheet's max (Solapur central → 19).
                        setMapMaxZoom(21);
                        return;
                    }
                    // At zoom limit but no tile data here — lock zoom and show "no data" message
                    setMapMaxZoom(MAX_FREE_ZOOM);
                    dialogTriggeredByRegionEntry = true;
                    showNoDataDialog();
                } else if (z >= MAX_FREE_ZOOM && district && !hasPurchase(district.productPurchaseID)) {
                    // Clamp zoom so the in-flight wheel/pinch animation stops cleanly at 14.
                    setMapMaxZoom(MAX_FREE_ZOOM);
                    dialogTriggeredByRegionEntry = true;

                    // Defer the dialog until the camera animation settles at 14. zoom_changed
                    // fires on the input tick with the target zoom, but the visual animation
                    // takes another ~150–300 ms — showing the dialog now would catch the map
                    // mid-flight and make it look like the paywall appeared at zoom 13.
                    // Guarded so only one idle listener is queued per gesture, not per tick.
                    if (!_pendingLockedIdle) {
                        _pendingLockedIdle = true;
                        google.maps.event.addListenerOnce(map, 'idle', function() {
                            _pendingLockedIdle = false;
                            if (map.getZoom() < MAX_FREE_ZOOM) return;
                            var stillLocked = findDistrictAtFocusOrCenter();
                            if (!stillLocked) return;
                            if (hasPurchase(stillLocked.productPurchaseID)) return;
                            var pid = stillLocked.productPurchaseID;

                            // Show the paywall IMMEDIATELY — no network wait, so it never feels
                            // laggy. If the user owns a confused-partner region (owns Pune, zooming
                            // into PMRDA), clear up the confusion first, then the paywall.
                            var owned = ownedConfusionPartner(pid);
                            if (owned) {
                                showRegionMismatchDialog(stillLocked, owned);
                            } else {
                                showZoomRestrictionDialog(stillLocked);
                            }

                            // Then re-check Firebase fresh in the BACKGROUND and auto-dismiss the
                            // paywall if the user actually owns this region. The local hasPurchase()
                            // cache can lag a just-completed purchase (the server getPurchaseStatus
                            // that fills it races RTDB replication on its own backend connection), so
                            // confirm against Firebase directly — a client read is fresher than the
                            // server function. This only ever ADDS an unlock; a genuine non-owner
                            // keeps the paywall, so it can never wrongly grant access.
                            //
                            // READS KEPT MINIMAL — at most one check per 2s per region (debounced),
                            // and none at all for an owner whose cache is already synced (returned
                            // above). Each check reads only this user's own nodes for this one pid.
                            var nowMs = Date.now();
                            if (pid === _lastFirebaseCheckPid && nowMs - _lastFirebaseCheckTime <= 2000) return;
                            _lastFirebaseCheckPid = pid;
                            _lastFirebaseCheckTime = nowMs;
                            // skipBackgroundSync=true: this is the lag-rescue path, so don't let the
                            // redundant server re-fetch re-clamp zoom right after we unlock.
                            checkFirebasePurchaseEntry(pid, true).then(function(ownedFresh) {
                                if (!ownedFresh) return;                     // genuinely not owned — paywall stays
                                if (map.getZoom() < MAX_FREE_ZOOM) return;  // user zoomed out meanwhile
                                var ov = document.getElementById('zoom-restrict-overlay');
                                if (ov && ov.classList.contains('open')) {
                                    ov.classList.remove('open');
                                    enableMapInteraction();
                                }
                                setMapMaxZoom(21);
                                showUnlockToast(stillLocked.districtName);
                                lastCheckedRegionId = null;
                                stickyTile = null;
                                stickyDistrict = null;
                                checkRegionOnMove();
                            }).catch(function() { /* network failed — paywall stays, the correct default */ });
                        });
                    }
                } else if (z < MAX_FREE_ZOOM && overlay.classList.contains('open')) {
                    // Zoomed out — auto-dismiss dialog
                    overlay.classList.remove('open');
                    enableMapInteraction();
                } else if (z < MAX_FREE_ZOOM) {
                    // Zoomed out — also dismiss the region-mismatch clearance dialog if open
                    var mmOverlay = document.getElementById('region-mismatch-overlay');
                    if (mmOverlay && mmOverlay.classList.contains('open')) {
                        mmOverlay.classList.remove('open');
                        enableMapInteraction();
                    }
                }
            });

            // ----- Zoom-exceeds-overlay-max warning toast -----
            // Fires when user's zoom is higher than the maxZoom of every overlay covering the map center.
            // Suppressed while user stays at/above the same threshold; re-fires on new threshold or when they re-exceed.
            let _lastZoomToastMax = null;
            let _zoomToastTimer = null;
            function showZoomMaxToast(currentZoom, overlayMax) {
                const toast = document.getElementById('zoom-info-toast');
                const text = document.getElementById('zoom-info-toast-text');
                if (!toast || !text) return;
                text.textContent = 'No data available at zoom ' + currentZoom + ' — max zoom here is ' + overlayMax;
                toast.classList.add('show');
                clearTimeout(_zoomToastTimer);
                _zoomToastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
            }
            function checkOverlayZoomLimit(z, centerLatLng) {
                if (zoomBypassActive || mapInteractionDisabled) return;
                if (!centerLatLng) return;
                const centerPoint = { lat: centerLatLng.lat(), lng: centerLatLng.lng() };
                let overlayMax = -1;
                const sources = [];
                if (isDPLayerVisible && !isShowingOldMaps && typeof dpLayerData !== 'undefined' && dpLayerData.length) sources.push(dpLayerData);
                if (isShowingOldMaps && typeof oldDPLayerData !== 'undefined' && oldDPLayerData.length) sources.push(oldDPLayerData);
                if (isVillageLayerVisible && typeof villageLayerData !== 'undefined' && villageLayerData.length) sources.push(villageLayerData);
                for (const arr of sources) {
                    for (const ov of arr) {
                        const bb = ov.bbox;
                        if (!bb) continue;
                        // Cheap outer-bbox reject (works for merged + un-merged)
                        if (centerPoint.lat < bb.minLat || centerPoint.lat > bb.maxLat ||
                            centerPoint.lng < bb.minLng || centerPoint.lng > bb.maxLng) continue;
                        // PERF (maps10 fix #2): for merged entries this walks
                        // sub-sheet polygons rather than the merged rectangle
                        // so PMRDA's wide bbox doesn't falsely cover Pune-only
                        // points.
                        var ovCheck = _checkLayerEntryAtPoint(ov, centerPoint);
                        if (!ovCheck.inside) continue;
                        const m = (typeof ov.maxZoom === 'number') ? ov.maxZoom : 22;
                        if (m > overlayMax) overlayMax = m;
                    }
                }
                if (overlayMax < 0) { _lastZoomToastMax = null; return; }  // no overlay here — existing handlers cover it
                if (z > overlayMax) {
                    if (_lastZoomToastMax !== overlayMax) {
                        showZoomMaxToast(z, overlayMax);
                        _lastZoomToastMax = overlayMax;
                    }
                } else {
                    _lastZoomToastMax = null;
                }
            }

            // Projection helper for converting LatLng to screen pixels (magnifier)
            projHelper = new google.maps.OverlayView();
            projHelper.draw = function() {};
            projHelper.setMap(map);

            // Define MeasureLabelOverlay (needs google.maps.OverlayView which loads with the API)
            MeasureLabelOverlay = class extends google.maps.OverlayView {
                constructor(position, text, mapInstance) {
                    super();
                    this._position = position;
                    this._text = text;
                    this._div = null;
                    this.setMap(mapInstance);
                }
                onAdd() {
                    this._div = document.createElement('div');
                    this._div.className = 'measure-label';
                    this._div.textContent = this._text;
                    this.getPanes().floatPane.appendChild(this._div);
                }
                draw() {
                    const proj = this.getProjection();
                    if (!proj) return;
                    const pos = proj.fromLatLngToDivPixel(this._position);
                    if (pos && this._div) {
                        this._div.style.left = pos.x + 'px';
                        this._div.style.top = pos.y + 'px';
                    }
                }
                onRemove() {
                    if (this._div && this._div.parentNode) {
                        this._div.parentNode.removeChild(this._div);
                        this._div = null;
                    }
                }
            };

            // PERF (maps7): single canvas-backed OverlayView for ALL village
            // boundaries. Replaces ~3000 google.maps.Polyline objects per district
            // with one <canvas> + one draw() loop. Eliminates the multi-second
            // pan stall observed when Pune's geojson was overlaid.
            const VillageBoundaryOverlayClass = class extends google.maps.OverlayView {
                constructor() {
                    super();
                    this._canvas = null;
                }
                onAdd() {
                    const c = document.createElement('canvas');
                    c.style.position = 'absolute';
                    c.style.pointerEvents = 'none';
                    c.style.left = '0';
                    c.style.top = '0';
                    this._canvas = c;
                    this.getPanes().overlayLayer.appendChild(c);
                }
                onRemove() {
                    if (this._canvas && this._canvas.parentNode) {
                        this._canvas.parentNode.removeChild(this._canvas);
                    }
                    this._canvas = null;
                }
                requestRedraw() {
                    // Force a draw() outside of Google Maps' usual viewport-change
                    // schedule (e.g. when district data lands async).
                    if (this._canvas) this.draw();
                }
                draw() {
                    // PERF (perf #12 v2 REVERTED): tried caching projected
                    // vertices in WORLD pixel space (manual mercator) and
                    // applying a per-draw world->div translation delta.
                    // Worked on pure pans but caused boundaries to "shift then
                    // snap" during zoom animations. Root cause: Google Maps'
                    // zoom animation appears to apply a CSS transform to the
                    // OverlayView pane during the transition, which is not a
                    // pure translation. A single-reference-point delta can't
                    // capture a CSS scale, so the cached coords don't line up
                    // with the visually-animating tiles until the animation
                    // settles. The original un-cached path doesn't have this
                    // issue because proj.fromLatLngToDivPixel is reactive to
                    // the in-progress animation state.
                    //
                    // For now: re-project every visible vertex per draw via
                    // the native projection. Costs ~2500 native crossings per
                    // pan but stays correct under all conditions including
                    // zoom animations.
                    if (!this._canvas) return;
                    const proj = this.getProjection();
                    if (!proj) return;
                    const m = this.getMap();
                    if (!m) return;
                    const bounds = m.getBounds();
                    if (!bounds) return;
                    const zoom = m.getZoom();

                    // Below MIN_ZOOM_FOR_GEOJSON or no data → empty canvas
                    if (zoom < MIN_ZOOM_FOR_GEOJSON || renderedDistricts.size === 0) {
                        if (this._canvas.width !== 0) {
                            this._canvas.width = 0;
                            this._canvas.height = 0;
                        }
                        return;
                    }

                    const ne = bounds.getNorthEast();
                    const sw = bounds.getSouthWest();
                    const nePx = proj.fromLatLngToDivPixel(ne);
                    const swPx = proj.fromLatLngToDivPixel(sw);
                    if (!nePx || !swPx) return;

                    const w = Math.max(1, Math.ceil(nePx.x - swPx.x));
                    const h = Math.max(1, Math.ceil(swPx.y - nePx.y));

                    // Resize-and-clear (writing width clears the canvas)
                    if (this._canvas.width !== w) this._canvas.width = w;
                    if (this._canvas.height !== h) this._canvas.height = h;
                    this._canvas.style.left = swPx.x + 'px';
                    this._canvas.style.top = nePx.y + 'px';
                    this._canvas.style.width = w + 'px';
                    this._canvas.style.height = h + 'px';

                    const ctx = this._canvas.getContext('2d');
                    ctx.clearRect(0, 0, w, h);
                    ctx.lineWidth = 2;
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';

                    const vpN = ne.lat();
                    const vpS = sw.lat();
                    const vpE = ne.lng();
                    const vpW = sw.lng();
                    const offX = swPx.x;
                    const offY = nePx.y;

                    for (const entry of renderedDistricts.values()) {
                        if (entry.loading || !entry.villages || entry.villages.length === 0) continue;
                        ctx.strokeStyle = GEOJSON_DISTRICT_COLORS[entry.colorIndex % GEOJSON_DISTRICT_COLORS.length];
                        ctx.beginPath();
                        let pathHas = false;

                        for (let vi = 0; vi < entry.villages.length; vi++) {
                            const v = entry.villages[vi];
                            const vb = v.bounds;
                            if (!vb) continue;
                            // Cheap bbox cull — skip villages outside viewport
                            if (vb.s > vpN || vb.n < vpS || vb.w > vpE || vb.e < vpW) continue;

                            const polys = v.polygons;
                            if (!polys) continue;
                            for (let pi = 0; pi < polys.length; pi++) {
                                const ring = polys[pi];
                                if (!ring || ring.length < 2) continue;
                                const first = proj.fromLatLngToDivPixel(ring[0]);
                                if (!first) continue;
                                ctx.moveTo(first.x - offX, first.y - offY);
                                for (let i = 1; i < ring.length; i++) {
                                    const p = proj.fromLatLngToDivPixel(ring[i]);
                                    if (!p) continue;
                                    ctx.lineTo(p.x - offX, p.y - offY);
                                }
                                // Close ring back to first vertex
                                ctx.lineTo(first.x - offX, first.y - offY);
                                pathHas = true;
                            }
                        }
                        if (pathHas) ctx.stroke();
                    }
                }
            };
            villageBoundaryOverlay = new VillageBoundaryOverlayClass();
            villageBoundaryOverlay.setMap(map);

            // Define VertexHandleOverlay (move handle + delete button above a vertex)
            VertexHandleOverlay = class extends google.maps.OverlayView {
                constructor(marker, callbacks, mapInstance) {
                    super();
                    this._marker = marker;
                    this._callbacks = callbacks;
                    this._isSaved = callbacks.isSaved;
                    this._div = null;
                    this._dragging = false;
                    this.setMap(mapInstance);
                }
                onAdd() {
                    const self = this;
                    this._div = document.createElement('div');
                    this._div.className = 'vertex-handle-container';

                    // Move handle (orange circle with cross arrows SVG)
                    const moveBtn = document.createElement('div');
                    moveBtn.className = 'vertex-move-handle';
                    moveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><polyline points="8,7 12,3 16,7"/><polyline points="8,17 12,21 16,17"/><polyline points="7,8 3,12 7,16"/><polyline points="17,8 21,12 17,16"/></svg>';

                    // Delete button (red × circle)
                    const delBtn = document.createElement('div');
                    delBtn.className = 'vertex-del-btn';
                    delBtn.textContent = '\u00D7';
                    delBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        self._callbacks.onDelete();
                    });
                    delBtn.addEventListener('touchend', function(e) {
                        e.stopPropagation();
                        e.preventDefault();
                        self._callbacks.onDelete();
                    });

                    this._div.appendChild(moveBtn);
                    this._div.appendChild(delBtn);

                    // --- Drag handling on move handle ---
                    let startX, startY, startLatLng;

                    const onDragStart = function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        self._dragging = true;
                        const touch = e.touches ? e.touches[0] : e;
                        startX = touch.clientX;
                        startY = touch.clientY;
                        startLatLng = self._marker.getPosition();
                        map.setOptions({ gestureHandling: 'none' });
                        moveBtn.style.background = '#E64A19';
                        showMagnifier(startLatLng);
                        document.addEventListener('mousemove', onDragMove);
                        document.addEventListener('mouseup', onDragEnd);
                        document.addEventListener('touchmove', onDragMove, { passive: false });
                        document.addEventListener('touchend', onDragEnd);
                    };

                    const onDragMove = function(e) {
                        if (!self._dragging) return;
                        e.preventDefault();
                        const touch = e.touches ? e.touches[0] : e;
                        const dx = touch.clientX - startX;
                        const dy = touch.clientY - startY;
                        const proj = self.getProjection();
                        if (!proj) return;
                        const startPx = proj.fromLatLngToDivPixel(startLatLng);
                        const newPx = new google.maps.Point(startPx.x + dx, startPx.y + dy);
                        const newLatLng = proj.fromDivPixelToLatLng(newPx);
                        self._marker.setPosition(newLatLng);
                        self._callbacks.onMove(newLatLng);
                        self.draw();
                        moveMagnifier(newLatLng);
                    };

                    const onDragEnd = function() {
                        if (!self._dragging) return;
                        self._dragging = false;
                        map.setOptions({ gestureHandling: 'greedy' });
                        moveBtn.style.background = '#FF5722';
                        hideMagnifier();
                        document.removeEventListener('mousemove', onDragMove);
                        document.removeEventListener('mouseup', onDragEnd);
                        document.removeEventListener('touchmove', onDragMove);
                        document.removeEventListener('touchend', onDragEnd);
                        self._callbacks.onMoveEnd();
                    };

                    moveBtn.addEventListener('mousedown', onDragStart);
                    moveBtn.addEventListener('touchstart', onDragStart, { passive: false });

                    this.getPanes().floatPane.appendChild(this._div);
                }
                draw() {
                    const proj = this.getProjection();
                    if (!proj || !this._div) return;
                    const pos = proj.fromLatLngToDivPixel(this._marker.getPosition());
                    if (pos) {
                        this._div.style.left = pos.x + 'px';
                        this._div.style.top = pos.y + 'px';
                    }
                }
                onRemove() {
                    if (this._div && this._div.parentNode) {
                        this._div.parentNode.removeChild(this._div);
                        this._div = null;
                    }
                }
            };

            // Load saved measurements from localStorage
            loadSavedMeasurements();

            // Initialize UI event listeners
            initUIEvents();

            // Pre-fetch all pricing so purchase dialog opens instantly
            var pricingListenerRef = firebase.database().ref('appConfig/pricing');
            pricingListenerRef.on('value', function(snap) {
                cachedPricing.clear();
                var data = snap.val() || {};
                Object.entries(data).forEach(function(e) { cachedPricing.set(e[0], e[1]); });
            });

            // Pre-fetch subscription plan pricing
            var subPricingRef = firebase.database().ref('appConfig/subscriptionPlans');
            subPricingRef.on('value', function(snap) {
                cachedSubPricing.clear();
                var data = snap.val() || {};
                Object.entries(data).forEach(function(e) { cachedSubPricing.set(e[0], e[1]); });
                // Update subscription card labels from config
                var defaultPlan = data['default'] || {};
                var unit = defaultPlan.periodUnit || 'week';
                var unitLabel = unit === 'day' ? 'Daily' : unit === 'week' ? 'Weekly' : unit === 'month' ? 'Monthly' : unit;
                var el = document.getElementById('pd-sub-card-name');
                if (el) el.innerHTML = unitLabel + '<br>Subscription';
                var pl = document.getElementById('pd-sub-period-label');
                if (pl) pl.textContent = '/ ' + unit;
                var bl = document.getElementById('pd-sub-benefit-cost');
                if (bl) bl.textContent = '\u2713 Lower ' + unit + 'ly cost';
            });

            // Layer data loading deferred until CloudFront cookies are ready
            // (prevents tile overlays from being created before cookies exist)

            // Load sidebar navigation from Firebase. The sidebar is hidden until the
            // user opens it, so its Firebase fetch + DOM build can wait — we yield it
            // to requestIdleCallback to keep the main thread responsive during init.
            (window.requestIdleCallback || function(cb) { return setTimeout(cb, 1500); })(function() {
                initSidebar();
            });
        }

        // --- Left Sidebar: Firebase menuGIS navigation ---
        const MENU_DB_NAME = "menuGIS";
        const ICON_BASE_PRELOAD = `https://${TILE_HOST}/dpplans/0imagesGIS/`;
        let menuData = []; // all items from Firebase
        let stateList = []; // unique states for the rail
        let sidebarHistory = []; // breadcrumb: [{level, title, items}]

        function initSidebar() {
            const sidebarPanel = document.getElementById('sidebar-panel');
            const sidebarOverlay = document.getElementById('sidebar-overlay');
            const sidebarList = document.getElementById('sidebar-list');
            const sidebarTitle = document.getElementById('sidebar-title');
            const sidebarSearch = document.getElementById('sidebar-search');

            // Wire up browse button immediately (openRegionsBrowser is a stub until data loads)
            document.getElementById('btn-access-regions').addEventListener('click', function() {
                openRegionsBrowser();
            });

            function processMenuData(rawData) {
                menuData = [];
                for (const key in rawData) {
                    if (rawData.hasOwnProperty(key)) {
                        const item = rawData[key];
                        menuData.push({
                            id: key,
                            state: item.state || '',
                            district: item.district || '',
                            villagesJSON: item.villagesJSON || '',
                            iconState: item.iconState || '',
                            iconVillage: item.iconVillage || '',
                            productPurchaseID: item.productPurchaseID || ''
                        });
                    }
                }
            }

            function buildAfterMenuData() {
                // Build unique states list
                const stateMap = new Map();
                menuData.forEach(item => {
                    if (!item.state) return;
                    if (!stateMap.has(item.state)) {
                        stateMap.set(item.state, { name: item.state, count: 0, icon: item.iconState });
                    }
                    if (item.district) {
                        stateMap.get(item.state).count++;
                    } else {
                        const vCount = item.villagesJSON ? item.villagesJSON.split('\n').filter(l => l.includes('=')).length : 0;
                        stateMap.get(item.state).count += vCount;
                    }
                });

                stateList = Array.from(stateMap.values());
                preloadRegionIcons();
            }

            // Preload region icons into browser cache using Image objects (no CORS issues)
            function preloadRegionIcons() {
                var iconNames = new Set();
                menuData.forEach(function(item) {
                    if (item.iconState) iconNames.add(item.iconState);
                    if (item.iconVillage) iconNames.add(item.iconVillage);
                });
                iconNames.forEach(function(name) {
                    var img = new Image();
                    img.src = ICON_BASE_PRELOAD + name + '.png';
                });
            }

            // Try loading from cache first, then fetch from Firebase
            const cachedMenu = getCachedData('menu_regions');
            if (cachedMenu) {
                processMenuData(cachedMenu);
                buildAfterMenuData();
            }
            // Always fetch fresh data from Firebase (updates cache + refreshes if stale)
            database.ref(MENU_DB_NAME).once('value').then(snapshot => {
                const data = snapshot.val();
                if (!data) return;
                setCachedData('menu_regions', data);
                processMenuData(data);
                buildAfterMenuData();
            });

            // Background-prefetch village layer (d2.bin) so the top search bar can
            // surface MahaVillage entries even when the village toggle is off.
            (window.requestIdleCallback || function(cb) { return setTimeout(cb, 3000); })(function() {
                if (!villageDataLoaded) fetchVillageLayerData();
            }, { timeout: 3000 });

            // ===== Fullscreen Region Browser =====
            const regionBrowser = document.getElementById('region-browser');
            const regionGrid = document.getElementById('region-grid');
            const regionTitle = document.getElementById('region-browser-title');
            const regionSearch = document.getElementById('region-browser-search');
            let regionHistory = []; // [{title, items, type}]
            const ICON_BASE = `https://${TILE_HOST}/dpplans/0imagesGIS/`;

            openRegionsBrowser = function() {
                regionHistory = [];
                var items = stateList.map(function(st) {
                    var districtCount = menuData.filter(function(m) { return m.state === st.name && m.district; }).length;
                    var locationCount = 0;
                    menuData.filter(function(m) { return m.state === st.name; }).forEach(function(m) {
                        locationCount += countVillages(m.villagesJSON);
                    });
                    var sub = districtCount > 0
                        ? districtCount + ' districts'
                        : locationCount + ' locations';
                    // For states without sub-districts, attach productPurchaseID so badge renders
                    var pid = '';
                    if (districtCount === 0) {
                        var stateEntry = menuData.find(function(m) { return m.state === st.name && !m.district; });
                        if (stateEntry) pid = stateEntry.productPurchaseID;
                    }
                    return { name: st.name, sub: sub, icon: st.icon, hasChildren: true, productPurchaseID: pid };
                });
                pushRegionLevel('All Regions', items, 'state');
                regionBrowser.classList.add('open');
            };

            var regionBrowserClosing = false;
            function closeRegionBrowser() {
                regionBrowser.classList.remove('open');
                var depth = regionHistory.length;
                regionHistory = [];
                // Go back in browser history to clean up pushed states
                if (depth > 0) {
                    regionBrowserClosing = true;
                    history.go(-depth);
                    setTimeout(function() { regionBrowserClosing = false; }, 300);
                }
            }

            function pushRegionLevel(title, items, type) {
                regionHistory.push({ title: title, items: items, type: type });
                regionTitle.textContent = title;
                regionSearch.value = '';
                renderRegionGrid(items, type);
                // Push browser history state so device back button navigates within the menu
                history.pushState({ regionBrowser: true, depth: regionHistory.length }, '');
            }

            function popRegionLevel() {
                if (regionHistory.length <= 1) { closeRegionBrowser(); return; }
                history.back(); // triggers popstate which handles the actual UI update
            }

            function renderRegionGrid(items, type) {
                regionGrid.innerHTML = '';

                // Show install/share buttons only on first page (state level)
                var actionsWrap = document.getElementById('sidebar-actions-wrap');
                if (actionsWrap) {
                    actionsWrap.style.display = (type === 'state') ? 'flex' : 'none';
                }

                // Villages: horizontal list rows (icon left, name + coords right)
                if (type === 'village') {
                    regionGrid.style.gridTemplateColumns = '1fr';
                    regionGrid.style.maxWidth = '500px';
                    var highlightTerm = regionHistory[regionHistory.length - 1].highlightTerm || '';
                    items.forEach(function(item) {
                        var isHighlighted = highlightTerm && item.name.toLowerCase().includes(highlightTerm.toLowerCase());
                        var el = document.createElement('div');
                        el.style.cssText = 'display:flex;align-items:center;gap:12px;padding:11px 14px;background:#fff;border-radius:10px;cursor:pointer;border:1px solid ' + (isHighlighted ? '#4CAF50' : '#eee') + ';' + (isHighlighted ? 'background:#E8F5E9;' : '');
                        el.innerHTML =
                            '<div style="width:38px;height:38px;border-radius:10px;background:#e8f5e9;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#2E7D32;flex-shrink:0;">' + item.name.charAt(0) + '</div>' +
                            '<div style="flex:1;min-width:0;">' +
                            '<div style="font-size:13px;font-weight:600;color:#212121;">' + item.name + '</div>' +
                            '<div style="font-size:10px;color:#999;margin-top:2px;">' + (item.sub || '') + '</div></div>';
                        el.addEventListener('click', function() {
                            var currentEntry = regionHistory[regionHistory.length - 1];
                            goToLocation(item.lat, item.lng, item.name, currentEntry.productPurchaseID || '');
                            closeRegionBrowser();
                        });
                        regionGrid.appendChild(el);
                        if (isHighlighted) {
                            setTimeout(function() { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100);
                        }
                    });
                    return;
                }

                // Grid for states / districts
                regionGrid.style.gridTemplateColumns = '';
                regionGrid.style.maxWidth = '';

                // Add "Go to Location" card at top of state-level grid
                if (type === 'state') {
                    var goCard = document.createElement('div');
                    goCard.className = 'region-card';
                    goCard.innerHTML =
                        '<div class="region-card-placeholder" style="background:#fff;">' +
                        '<svg width="100" height="100" viewBox="0 0 469.333 469.333" fill="#333"><path d="M234.667,149.333c-47.147,0 -85.333,38.187 -85.333,85.333S187.52,320 234.667,320S320,281.813 320,234.667S281.813,149.333 234.667,149.333zM425.387,213.333C415.573,124.373 344.96,53.76 256,43.947V0h-42.667v43.947C124.373,53.76 53.76,124.373 43.947,213.333H0V256h43.947c9.813,88.96 80.427,159.573 169.387,169.387v43.947H256v-43.947C344.96,415.573 415.573,344.96 425.387,256h43.947v-42.667H425.387L425.387,213.333zM234.667,384c-82.453,0 -149.333,-66.88 -149.333,-149.333s66.88,-149.333 149.333,-149.333S384,152.213 384,234.667S317.12,384 234.667,384z"/></svg>' +
                        '</div>' +
                        '<div class="region-card-body"><div class="region-card-name">Go to Location</div></div>';
                    goCard.addEventListener('click', function() {
                        closeRegionBrowser();
                        setTimeout(function() {
                            document.getElementById('coord-dialog-overlay').classList.add('open');
                        }, 350);
                    });
                    regionGrid.appendChild(goCard);
                }

                items.forEach(function(item) {
                    var card = document.createElement('div');
                    card.className = 'region-card';

                    // Badge + purchased border
                    var badgeHtml = '';
                    var isPurchased = false;
                    if ((type === 'district' || type === 'state') && item.productPurchaseID) {
                        if (hasPurchase(item.productPurchaseID)) {
                            isPurchased = true;
                            var exp = getPurchaseExpiry(item.productPurchaseID);
                            var plan = getPurchasePlan(item.productPurchaseID);
                            if (plan === 'subscription') {
                                var cardSub = activeSubscriptions.get(item.productPurchaseID);
                                badgeHtml = '<div class="region-card-badge purchased">Subscription &middot; ' + formatSubscriptionCountdown(exp, cardSub && cardSub.status) + '</div>';
                            } else {
                                var days = calcDaysLeft(exp);
                                var planTag = plan === 'professional' ? 'Pro' : plan === 'web' ? 'Web' : plan === 'override' ? 'Override' : '7 Day';
                                badgeHtml = '<div class="region-card-badge purchased">' + planTag + ' Pass - ' + days + ' left</div>';
                            }
                            card.classList.add('has-purchase');
                        } else {
                            badgeHtml = '<div class="region-card-badge buy" data-pid="' + item.productPurchaseID + '" data-name="' + item.name + '">Buy</div>';
                        }
                    }

                    // Icon — served from browser cache (preloaded during init)
                    var iconName = item.icon || '';
                    var safeChar = item.name.charAt(0).replace(/'/g, '');

                    card.innerHTML = badgeHtml +
                        '<div class="region-card-body">' +
                        '<div class="region-card-name">' + item.name + '</div>' +
                        (item.sub ? '<div class="region-card-sub">' + item.sub + '</div>' : '') +
                        '</div>';

                    if (iconName) {
                        var img = document.createElement('img');
                        img.className = 'region-card-img';
                        img.onerror = function() {
                            var ph = document.createElement('div');
                            ph.className = 'region-card-placeholder';
                            ph.textContent = safeChar;
                            this.parentNode.replaceChild(ph, this);
                        };
                        img.src = ICON_BASE + iconName + '.png';
                        card.insertBefore(img, card.firstChild);
                    } else {
                        var ph = document.createElement('div');
                        ph.className = 'region-card-placeholder';
                        ph.textContent = safeChar;
                        card.insertBefore(ph, card.firstChild);
                    }

                    // Buy badge click
                    var buyBadge = card.querySelector('.region-card-badge.buy');
                    if (buyBadge) {
                        buyBadge.addEventListener('click', function(e) {
                            e.stopPropagation();
                            buyRegion(buyBadge.dataset.pid, buyBadge.dataset.name);
                        });
                    }

                    // Card click
                    card.addEventListener('click', function() {
                        if (type === 'state') {
                            openStateInBrowser(item.name);
                        } else if (type === 'district') {
                            openDistrictVillages(item.name, item.villagesJSON, item.productPurchaseID, item.matchedVillage || '');
                        }
                    });

                    regionGrid.appendChild(card);
                });
            }

            function openStateInBrowser(stateName) {
                var districts = menuData.filter(function(m) { return m.state === stateName && m.district; })
                    .sort(function(a, b) { return a.district.localeCompare(b.district); });
                var stateItem = menuData.find(function(m) { return m.state === stateName && !m.district; });

                if (districts.length === 1) {
                    // Single district — skip straight to its villages
                    openDistrictVillages(districts[0].district, districts[0].villagesJSON, districts[0].productPurchaseID);
                } else if (districts.length > 1) {
                    var items = districts.map(function(d) {
                        return {
                            name: d.district,
                            sub: countVillages(d.villagesJSON) + ' locations',
                            icon: d.iconVillage,
                            hasChildren: true,
                            villagesJSON: d.villagesJSON,
                            productPurchaseID: d.productPurchaseID
                        };
                    });
                    pushRegionLevel(stateName, items, 'district');
                } else if (stateItem && stateItem.villagesJSON) {
                    openDistrictVillages(stateName, stateItem.villagesJSON, stateItem.productPurchaseID);
                }
            }

            function openDistrictVillages(title, villagesJSON, productPurchaseID, highlightTerm) {
                var locations = parseVillagesJSON(villagesJSON);
                // Single village — go directly to map
                if (locations.length === 1 && !highlightTerm) {
                    goToLocation(locations[0].lat, locations[0].lng, locations[0].name, productPurchaseID || '');
                    closeRegionBrowser();
                    return;
                }
                var items = locations.map(function(loc) {
                    return { name: loc.name, sub: loc.lat.toFixed(4) + ', ' + loc.lng.toFixed(4), lat: loc.lat, lng: loc.lng };
                });
                var level = { title: title, items: items, type: 'village', productPurchaseID: productPurchaseID || '', highlightTerm: highlightTerm || '' };
                regionHistory.push(level);
                history.pushState({ regionBrowser: true, depth: regionHistory.length }, '');
                regionTitle.textContent = title;
                regionSearch.value = '';
                renderRegionGrid(items, 'village');
            }

            // Browser controls
            document.getElementById('region-browser-back').addEventListener('click', popRegionLevel);
            document.getElementById('region-browser-close').addEventListener('click', closeRegionBrowser);
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && regionBrowser.classList.contains('open')) {
                    e.preventDefault();
                    popRegionLevel();
                }
            });

            // Handle device back button (popstate) — navigate within region browser
            window.addEventListener('popstate', function(e) {
                if (regionBrowserClosing) return; // ignore popstate during cleanup
                if (regionBrowser.classList.contains('open')) {
                    if (regionHistory.length <= 1) {
                        regionBrowser.classList.remove('open');
                        regionHistory = [];
                    } else {
                        regionHistory.pop();
                        var prev = regionHistory[regionHistory.length - 1];
                        regionTitle.textContent = prev.title;
                        regionSearch.value = '';
                        renderRegionGrid(prev.items, prev.type);
                    }
                }
            });

            // Search in browser — deep search into villages for district level
            regionSearch.addEventListener('input', function() {
                var q = this.value.trim().toLowerCase();
                var current = regionHistory[regionHistory.length - 1];
                if (!current) return;
                if (!q) { renderRegionGrid(current.items, current.type); return; }

                if (current.type === 'district') {
                    // Search district names AND villages inside each district
                    var results = [];
                    current.items.forEach(function(item) {
                        if (item.name.toLowerCase().includes(q)) {
                            results.push(item);
                            return;
                        }
                        if (item.villagesJSON) {
                            var matched = [];
                            item.villagesJSON.split('\n').forEach(function(line) {
                                var parts = line.split('=');
                                if (parts.length === 2 && parts[0].trim().toLowerCase().includes(q)) {
                                    matched.push(parts[0].trim());
                                }
                            });
                            if (matched.length > 0) {
                                var clone = {};
                                for (var k in item) clone[k] = item[k];
                                clone.matchedVillage = matched[0];
                                clone.sub = 'Contains: ' + matched.slice(0, 2).join(', ') + (matched.length > 2 ? ' +' + (matched.length - 2) + ' more' : '');
                                results.push(clone);
                            }
                        }
                    });
                    renderRegionGrid(results, current.type);
                } else {
                    var filtered = current.items.filter(function(item) {
                        return item.name.toLowerCase().includes(q);
                    });
                    renderRegionGrid(filtered, current.type);
                }
            });

            function openState(stateName) {
                const districts = menuData.filter(m => m.state === stateName && m.district);
                const stateItem = menuData.find(m => m.state === stateName && !m.district);

                if (districts.length > 0) {
                    // Has districts -- show district list
                    const items = districts.map(d => ({
                        name: d.district,
                        sub: countVillages(d.villagesJSON) + ' locations',
                        hasChildren: true,
                        villagesJSON: d.villagesJSON,
                        productPurchaseID: d.productPurchaseID
                    }));
                    showSidebarLevel(stateName, items, 'district');
                } else if (stateItem && stateItem.villagesJSON) {
                    // No districts -- show villages directly
                    showVillages(stateName, stateItem.villagesJSON, null, stateItem.productPurchaseID);
                }
                openSidebar();
            }

            function showSidebarLevel(title, items, type) {
                sidebarTitle.textContent = title;
                sidebarSearch.value = '';
                sidebarHistory.push({ title, items, type });
                renderSidebarList(items, type);
            }

            function showVillages(title, villagesJSON, highlightTerm, productPurchaseID) {
                const locations = parseVillagesJSON(villagesJSON);
                const items = locations.map(loc => ({
                    name: loc.name,
                    sub: loc.lat.toFixed(4) + ', ' + loc.lng.toFixed(4),
                    hasChildren: false,
                    lat: loc.lat, lng: loc.lng
                }));
                showSidebarLevel(title, items, 'village');
                // Store productPurchaseID on history entry for village click handler
                sidebarHistory[sidebarHistory.length - 1].productPurchaseID = productPurchaseID || '';

                // Scroll to and highlight the matched village
                if (highlightTerm) {
                    const q = highlightTerm.toLowerCase();
                    const btns = sidebarList.querySelectorAll('.sidebar-list-item');
                    btns.forEach(btn => {
                        const name = btn.querySelector('.sidebar-list-name');
                        if (name && name.textContent.toLowerCase().includes(q)) {
                            btn.style.background = '#e8f5e9';
                            btn.style.borderLeft = '3px solid #2E7D32';
                            // Highlight the match text
                            name.innerHTML = name.textContent.replace(
                                new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'),
                                '<mark style="background:#fff3cd;border-radius:2px;padding:0 2px">$1</mark>'
                            );
                            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    });
                }
            }

            function renderSidebarList(items, type, searchTerm) {
                sidebarList.innerHTML = '';
                items.forEach(item => {
                    const btn = document.createElement('button');
                    btn.className = 'sidebar-list-item';

                    // Purchase badge for districts
                    let badge = '';
                    if ((type === 'district' || type === 'state') && item.productPurchaseID) {
                        if (hasPurchase(item.productPurchaseID)) {
                            const expiry = getPurchaseExpiry(item.productPurchaseID);
                            const plan = getPurchasePlan(item.productPurchaseID);
                            if (plan === 'subscription') {
                                const listSub = activeSubscriptions.get(item.productPurchaseID);
                                badge = '<span style="font-size:9px;background:#4CAF50;color:#fff;padding:1px 6px;border-radius:8px;margin-left:auto;flex-shrink:0" title="Subscriptions renew at the start of the day">Sub \u00b7 ' + formatSubscriptionCountdown(expiry, listSub && listSub.status) + '</span>';
                            } else {
                                const daysLeft = calcDaysLeft(expiry);
                                const planTag = plan === 'professional' ? 'Pro' : plan === 'web' ? 'Web' : plan === 'override' ? 'Override' : '7 Day';
                                badge = '<span style="font-size:9px;background:#4CAF50;color:#fff;padding:1px 6px;border-radius:8px;margin-left:auto;flex-shrink:0">' + planTag + ' \u00b7 ' + daysLeft + ' left</span>';
                            }
                        } else {
                            badge = '<span style="font-size:9px;background:#FF9800;color:#fff;padding:1px 6px;border-radius:8px;margin-left:auto;flex-shrink:0;cursor:pointer" class="buy-badge" data-pid="' + item.productPurchaseID + '" data-name="' + item.name + '">Buy 7-Day Pass</span>';
                        }
                    }

                    btn.innerHTML = `
                        <div class="sidebar-list-icon">${item.name.charAt(0)}</div>
                        <div class="sidebar-list-text">
                            <div class="sidebar-list-name">${item.name}</div>
                            <div class="sidebar-list-sub">${item.sub || ''}</div>
                        </div>
                        ${badge}
                        ${item.hasChildren ? '<span class="sidebar-list-arrow">&#8250;</span>' : ''}
                    `;

                    // Buy badge click (stop propagation so it doesn't drill into district)
                    const buyBadge = btn.querySelector('.buy-badge');
                    if (buyBadge) {
                        buyBadge.addEventListener('click', (e) => {
                            e.stopPropagation();
                            buyRegion(buyBadge.dataset.pid, buyBadge.dataset.name);
                        });
                    }

                    btn.addEventListener('click', () => {
                        if (type === 'state') {
                            openState(item.name);
                        } else if (type === 'district') {
                            const currentQuery = sidebarSearch.value.trim();
                            showVillages(item.name, item.villagesJSON, currentQuery || null, item.productPurchaseID);
                        } else if (type === 'village') {
                            const currentEntry = sidebarHistory[sidebarHistory.length - 1];
                            goToLocation(item.lat, item.lng, item.name, currentEntry?.productPurchaseID);
                            closeSidebar();
                        }
                    });
                    sidebarList.appendChild(btn);
                });
            }

            function parseVillagesJSON(json) {
                if (!json) return [];
                return json.split('\n').map(line => {
                    const parts = line.split('=');
                    if (parts.length !== 2) return null;
                    const name = parts[0].trim();
                    const coords = parts[1].trim().split(',');
                    if (coords.length < 2) return null;
                    const lat = parseFloat(coords[0]);
                    const lng = parseFloat(coords[1]);
                    if (isNaN(lat) || isNaN(lng)) return null;
                    return { name, lat, lng };
                }).filter(Boolean);
            }

            function countVillages(json) {
                if (!json) return 0;
                return json.split('\n').filter(l => l.includes('=')).length;
            }

            function goToLocation(lat, lng, name, districtProductId) {
                zoomBypassActive = true;
                if (districtProductId && hasPurchase(districtProductId)) {
                    setMapMaxZoom(21);
                }
                map.panTo({ lat, lng });
                var targetZoom = (districtProductId && hasPurchase(districtProductId)) ? 15 : MAX_FREE_ZOOM - 1;
                smoothZoomTo(targetZoom);
                google.maps.event.addListenerOnce(map, 'idle', () => { zoomBypassActive = false; });
                updateStatus('Zoomed to ' + name);
            }

            // Expose to other outer-scope closures (e.g. renderSettingsPurchases
            // inside initUIEvents) that need to parse village JSON and pan the
            // map. Both functions are nested inside initSidebar() so they'd
            // otherwise be trapped in this closure and unreachable from sibling
            // init functions. See commit bcdf952 for the caller.
            window.parseVillagesJSON = parseVillagesJSON;
            window.goToLocation = goToLocation;

            function openSidebar() {
                sidebarPanel.classList.add('open');
                sidebarOverlay.classList.add('open');
            }

            function closeSidebar() {
                sidebarPanel.classList.remove('open');
                sidebarOverlay.classList.remove('open');
                sidebarHistory = [];
            }

            // Sidebar back button
            document.getElementById('sidebar-back').addEventListener('click', () => {
                if (sidebarHistory.length > 1) {
                    sidebarHistory.pop();
                    const prev = sidebarHistory[sidebarHistory.length - 1];
                    sidebarTitle.textContent = prev.title;
                    sidebarSearch.value = '';
                    renderSidebarList(prev.items, prev.type);
                } else {
                    closeSidebar();
                }
            });

            // Sidebar overlay close
            sidebarOverlay.addEventListener('click', closeSidebar);


            // Sidebar search filter -- also searches inside villagesJSON for district-level items
            sidebarSearch.addEventListener('input', function() {
                const q = this.value.trim().toLowerCase();
                const current = sidebarHistory[sidebarHistory.length - 1];
                if (!current) return;

                if (!q) {
                    renderSidebarList(current.items, current.type);
                    return;
                }

                if (current.type === 'state') {
                    // Search state names
                    const filtered = current.items.filter(item => item.name.toLowerCase().includes(q));
                    renderSidebarList(filtered, current.type);
                } else if (current.type === 'district') {
                    // Search district names AND villages inside each district
                    const results = [];
                    current.items.forEach(item => {
                        if (item.name.toLowerCase().includes(q)) {
                            results.push(item);
                            return;
                        }
                        // Search villages inside this district
                        if (item.villagesJSON) {
                            const matchedVillages = [];
                            item.villagesJSON.split('\n').forEach(line => {
                                const parts = line.split('=');
                                if (parts.length !== 2) return;
                                const vName = parts[0].trim();
                                if (vName.toLowerCase().includes(q)) matchedVillages.push(vName);
                            });
                            if (matchedVillages.length > 0) {
                                results.push({
                                    ...item,
                                    sub: 'Contains: ' + matchedVillages.slice(0, 3).join(', ') +
                                         (matchedVillages.length > 3 ? ' +' + (matchedVillages.length - 3) + ' more' : '')
                                });
                            }
                        }
                    });
                    renderSidebarList(results, current.type);
                } else {
                    const filtered = current.items.filter(item =>
                        item.name.toLowerCase().includes(q) ||
                        (item.sub && item.sub.toLowerCase().includes(q))
                    );
                    renderSidebarList(filtered, current.type);
                }
            });

            // --- Top search bar: search through all Firebase locations ---
            const searchInput = document.getElementById('search-input');
            const searchResultsEl = document.getElementById('search-results');
            let searchDebounce = null;
            let searchActiveIndex = -1;

            function updateSearchHighlight() {
                const items = searchResultsEl.querySelectorAll('.search-result-item');
                items.forEach((it, i) => {
                    const active = i === searchActiveIndex;
                    it.classList.toggle('active', active);
                    if (active) it.scrollIntoView({ block: 'nearest' });
                });
            }

            // Native X (clear) button on <input type="search"> fires 'input', not
            // 'keyup'. Catch that path so clearing reopens the recents view
            // instead of leaving the previous results onscreen.
            searchInput.addEventListener('input', function() {
                if (this.value.trim() === '') {
                    clearTimeout(searchDebounce);
                    renderSearchChipsView();
                }
            });

            // Use keyup (not input) -- Google Places SearchBox can suppress input events
            searchInput.addEventListener('keyup', function(e) {
                if (e && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape')) return;
                clearTimeout(searchDebounce);
                const q = this.value.trim().toLowerCase();
                if (q.length < 2) {
                    // Empty/short input → show recent-pick chips (or close panel if no history)
                    renderSearchChipsView();
                    return;
                }
                // Run search if we have data OR if this looks like coordinates
                if (menuData.length === 0 && !detectCoordsInQuery(q)) {
                    searchResultsEl.classList.remove('open');
                    return;
                }
                searchDebounce = setTimeout(() => searchMenuData(q), 150);
            });

            searchInput.addEventListener('keydown', function(e) {
                if (!searchResultsEl.classList.contains('open')) return;
                const items = searchResultsEl.querySelectorAll('.search-result-item');
                if (items.length === 0) return;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    searchActiveIndex = (searchActiveIndex + 1) % items.length;
                    updateSearchHighlight();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    searchActiveIndex = (searchActiveIndex - 1 + items.length) % items.length;
                    updateSearchHighlight();
                } else if (e.key === 'Enter') {
                    if (searchActiveIndex >= 0 && searchActiveIndex < items.length) {
                        e.preventDefault();
                        items[searchActiveIndex].click();
                    }
                } else if (e.key === 'Escape') {
                    searchResultsEl.classList.remove('open');
                    searchActiveIndex = -1;
                }
            });

            searchInput.addEventListener('focus', function() {
                const q = this.value.trim().toLowerCase();
                if (q.length >= 2 && menuData.length > 0) {
                    searchMenuData(q);
                } else {
                    // Open chip view on focus when the input is empty so the user
                    // can re-open a recent pick with one tap.
                    renderSearchChipsView();
                }
            });

            // Close results when clicking outside
            document.addEventListener('click', function(e) {
                if (!searchResultsEl.contains(e.target) && e.target !== searchInput) {
                    searchResultsEl.classList.remove('open');
                }
            });

            // === Search picks: localStorage-backed click history + counts ===
            // Shape: { recent: [{name, lat, lng, type, productPurchaseID, bbox, addedAt} x8 MRU],
            //          counts: { "<name>": clickCount } }
            // Recent chips show when the search input is empty/focused.
            // Counts boost matching results in the ranked list.
            const SEARCH_PICKS_KEY = 'gis_search_picks';
            const SEARCH_PICKS_MAX_RECENT = 8;
            const SEARCH_PICKS_MAX_COUNTS = 200;
            let _searchPicks = null;

            function loadSearchPicks() {
                if (_searchPicks) return _searchPicks;
                try {
                    const raw = localStorage.getItem(SEARCH_PICKS_KEY);
                    if (raw) {
                        const parsed = JSON.parse(raw);
                        if (parsed && Array.isArray(parsed.recent) && parsed.counts && typeof parsed.counts === 'object') {
                            _searchPicks = parsed;
                            return _searchPicks;
                        }
                    }
                } catch (e) { /* corrupt → reset */ }
                _searchPicks = { recent: [], counts: {} };
                return _searchPicks;
            }

            function saveSearchPicks() {
                try { localStorage.setItem(SEARCH_PICKS_KEY, JSON.stringify(_searchPicks)); }
                catch (e) { /* quota — drop silently */ }
            }

            function recordSearchPick(r) {
                // Only track navigable picks (have lat/lng). District/state picks open
                // sidebars, not navigations, and chips can't easily replay that flow.
                if (!r || !r.name) return;
                if (r.type !== 'coord' && r.type !== 'village' && r.type !== 'villagePlan') return;
                if (r.lat == null || r.lng == null) return;
                const picks = loadSearchPicks();
                picks.counts[r.name] = (picks.counts[r.name] || 0) + 1;
                // Cap counts dict: keep top-N by count, drop the rest
                const keys = Object.keys(picks.counts);
                if (keys.length > SEARCH_PICKS_MAX_COUNTS) {
                    const sorted = keys.sort((a, b) => picks.counts[b] - picks.counts[a]);
                    const trimmed = {};
                    sorted.slice(0, Math.floor(SEARCH_PICKS_MAX_COUNTS / 2)).forEach(k => {
                        trimmed[k] = picks.counts[k];
                    });
                    picks.counts = trimmed;
                }
                const slim = {
                    name: r.name,
                    type: r.type,
                    lat: r.lat, lng: r.lng,
                    productPurchaseID: r.productPurchaseID || (r.item && r.item.productPurchaseID) || '',
                    bbox: r.bbox || null,
                    addedAt: Date.now()
                };
                picks.recent = [slim, ...picks.recent.filter(x => x.name !== r.name)].slice(0, SEARCH_PICKS_MAX_RECENT);
                saveSearchPicks();
            }

            function invokeSearchPick(r) {
                if (r.type === 'coord') {
                    goToCoordinate(r.lat, r.lng, r.name);
                } else if (r.type === 'village' || r.type === 'villagePlan') {
                    goToLocation(r.lat, r.lng, r.name, r.productPurchaseID || '');
                    if (r.bbox && r.type === 'villagePlan') {
                        const b = new google.maps.LatLngBounds(
                            { lat: r.bbox.minLat, lng: r.bbox.minLng },
                            { lat: r.bbox.maxLat, lng: r.bbox.maxLng }
                        );
                        map.fitBounds(b);
                    }
                }
            }

            function renderSearchChipsView() {
                const picks = loadSearchPicks();
                if (!picks.recent.length) {
                    searchResultsEl.classList.remove('open');
                    return;
                }
                searchResultsEl.innerHTML = '';
                searchActiveIndex = -1;

                const header = document.createElement('div');
                header.className = 'search-result-header';
                header.style.display = 'flex';
                header.style.alignItems = 'center';
                const title = document.createElement('span');
                title.textContent = 'Recent';
                title.style.flex = '1';
                header.appendChild(title);
                const clearBtn = document.createElement('button');
                clearBtn.className = 'search-chip-clear';
                clearBtn.textContent = 'Clear';
                clearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    _searchPicks = { recent: [], counts: {} };
                    saveSearchPicks();
                    searchResultsEl.classList.remove('open');
                });
                header.appendChild(clearBtn);
                searchResultsEl.appendChild(header);

                const row = document.createElement('div');
                row.className = 'search-chip-row';
                picks.recent.forEach(r => {
                    const chip = document.createElement('button');
                    chip.className = 'search-chip';
                    chip.title = r.name;
                    chip.textContent = r.name;
                    chip.addEventListener('click', () => {
                        recordSearchPick(r);
                        invokeSearchPick(r);
                        searchResultsEl.classList.remove('open');
                        searchInput.value = r.name;
                    });
                    row.appendChild(chip);
                });
                searchResultsEl.appendChild(row);
                searchResultsEl.classList.add('open');
            }

            function searchMenuData(query) {
                const results = [];
                const addedStates = new Set();
                const addedDistricts = new Set();
                const addedVillageNames = new Set(); // dedup gate for MahaVillage pass

                // Auto-detect coordinates in the query and surface a direct "Go to" result at the top
                const coordHit = detectCoordsInQuery(query);
                if (coordHit) {
                    results.push({
                        name: coordHit.label,
                        path: 'Go to these coordinates',
                        type: 'coord',
                        lat: coordHit.lat,
                        lng: coordHit.lng
                    });
                }

                menuData.forEach(item => {
                    const state = item.state || '';
                    const district = item.district || '';

                    // Check state name match (deduplicate)
                    if (state.toLowerCase().includes(query) && !addedStates.has(state)) {
                        addedStates.add(state);
                        results.push({
                            name: state,
                            path: 'State',
                            type: 'state',
                            item: item
                        });
                    }

                    // Check district name match (deduplicate)
                    if (district && district.toLowerCase().includes(query) && !addedDistricts.has(state + district)) {
                        addedDistricts.add(state + district);
                        results.push({
                            name: district,
                            path: state,
                            type: 'district',
                            item: item
                        });
                    }

                    // Search through all villages/sub-locations
                    if (item.villagesJSON) {
                        item.villagesJSON.split('\n').forEach(line => {
                            const parts = line.split('=');
                            if (parts.length !== 2) return;
                            const villageName = parts[0].trim();
                            if (villageName.toLowerCase().includes(query)) {
                                const coords = parts[1].trim().split(',');
                                const lat = parseFloat(coords[0]);
                                const lng = parseFloat(coords[1]);
                                if (isNaN(lat) || isNaN(lng)) return;
                                const pathParts = [state];
                                if (district) pathParts.push(district);
                                // Headlines: curated top-of-district entries lack the
                                // ", Tal: <district>" suffix that real village lines have.
                                // They rank above villages within the same district hit.
                                const isHeadline = !villageName.includes(', Tal: ');
                                results.push({
                                    name: villageName,
                                    path: pathParts.join(' > ') + '  •  Found inside',
                                    type: 'village',
                                    lat: lat, lng: lng,
                                    isHeadline: isHeadline,
                                    item: item
                                });
                                addedVillageNames.add(villageName.toLowerCase());
                            }
                        });
                    }
                });

                // Second pass: surface MahaVillage (d2.bin) entries that aren't
                // already covered by menuGIS' villagesJSON. These carry a real
                // productPurchaseID + polygon bbox, so clicking can fitBounds and
                // open the purchase context. menuGIS wins on duplicates.
                // getVillageCenter falls back to polygon centroid when the entry's
                // pre-computed latLng field is empty — common in d2.bin.
                if (villageLayerData && villageLayerData.length > 0) {
                    villageLayerData.forEach(entry => {
                        const vName = entry.villageName || '';
                        if (!vName) return;
                        const vLower = vName.toLowerCase();
                        if (!vLower.includes(query)) return;
                        if (addedVillageNames.has(vLower)) return;
                        const center = getVillageCenter(entry);
                        if (!center) return;
                        addedVillageNames.add(vLower);
                        results.push({
                            name: vName,
                            path: 'Village Plan',
                            type: 'villagePlan',
                            lat: center.lat, lng: center.lng,
                            bbox: entry.bbox || null,
                            productPurchaseID: entry.productPurchaseID || '',
                            item: entry
                        });
                    });
                }

                // Sort priority:
                //   1. type bucket (coord → village → villagePlan → district → state)
                //   2. within bucket: curated headline rows first (only applies to 'village')
                //   3. within tier: user's personal pick count, most-clicked first
                //   4. stable insertion order (Array.sort is stable on V8/SpiderMonkey)
                const pickCounts = loadSearchPicks().counts;
                results.sort((a, b) => {
                    const order = { coord: -1, village: 0, villagePlan: 1, district: 2, state: 3 };
                    const typeOrder = (order[a.type] || 0) - (order[b.type] || 0);
                    if (typeOrder !== 0) return typeOrder;
                    const aHead = a.isHeadline ? 1 : 0;
                    const bHead = b.isHeadline ? 1 : 0;
                    if (aHead !== bHead) return bHead - aHead;
                    const aCount = pickCounts[a.name] || 0;
                    const bCount = pickCounts[b.name] || 0;
                    if (aCount !== bCount) return bCount - aCount;
                    return 0;
                });

                renderSearchResults(results.slice(0, 20), query);
            }

            function renderSearchResults(results, query) {
                searchResultsEl.innerHTML = '';
                searchActiveIndex = -1;

                if (results.length > 0) {
                    const header = document.createElement('div');
                    header.className = 'search-result-header';
                    header.textContent = 'Locations from plans';
                    searchResultsEl.appendChild(header);

                    results.forEach(r => {
                        const btn = document.createElement('button');
                        btn.className = 'search-result-item';
                        const highlighted = r.name.replace(
                            new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'),
                            '<mark>$1</mark>'
                        );
                        const icon = r.type === 'coord' ? '🎯' : r.type === 'village' ? '📍' : r.type === 'villagePlan' ? '🏘️' : r.type === 'district' ? '🏘' : '🗺';
                        // Coord result shouldn't get query highlighting (the name is formatted coords, not a text match)
                        const nameHtml = r.type === 'coord' ? r.name : highlighted;
                        btn.innerHTML = `
                            <div class="search-result-icon">${icon}</div>
                            <div class="search-result-text">
                                <div class="search-result-name">${nameHtml}</div>
                                <div class="search-result-path">${r.path}</div>
                            </div>
                        `;
                        btn.addEventListener('click', () => {
                            recordSearchPick(r);
                            if (r.type === 'coord') {
                                goToCoordinate(r.lat, r.lng, r.name);
                            } else if (r.type === 'village' && r.lat && r.lng) {
                                const pid = r.item ? r.item.productPurchaseID : '';
                                goToLocation(r.lat, r.lng, r.name, pid);
                            } else if (r.type === 'villagePlan' && r.lat && r.lng) {
                                // goToLocation first so it sets zoomBypassActive + purchase
                                // context + status text, then fitBounds frames the polygon
                                // footprint as the final framing.
                                goToLocation(r.lat, r.lng, r.name, r.productPurchaseID || '');
                                if (r.bbox) {
                                    const b = new google.maps.LatLngBounds(
                                        { lat: r.bbox.minLat, lng: r.bbox.minLng },
                                        { lat: r.bbox.maxLat, lng: r.bbox.maxLng }
                                    );
                                    map.fitBounds(b);
                                }
                            } else if (r.item) {
                                if (r.type === 'district' && r.item.villagesJSON) {
                                    showVillages(r.item.district || r.item.state, r.item.villagesJSON, null, r.item.productPurchaseID);
                                    openSidebar();
                                } else {
                                    openState(r.item.state);
                                }
                            }
                            searchResultsEl.classList.remove('open');
                            searchInput.value = r.name;
                        });
                        searchResultsEl.appendChild(btn);
                    });
                }

                // Always show "Search on Google Maps" fallback at the bottom
                const fallback = document.createElement('button');
                fallback.className = 'search-result-item';
                fallback.style.borderTop = '1px solid #eee';
                const fallbackIcon = document.createElement('div');
                fallbackIcon.className = 'search-result-icon';
                fallbackIcon.textContent = '🔍';
                const fallbackText = document.createElement('div');
                fallbackText.className = 'search-result-text';
                const fallbackName = document.createElement('div');
                fallbackName.className = 'search-result-name';
                fallbackName.innerHTML = 'Search "<strong></strong>" on Google Maps';
                fallbackName.querySelector('strong').textContent = query;
                const fallbackPath = document.createElement('div');
                fallbackPath.className = 'search-result-path';
                fallbackPath.textContent = results.length === 0 ? 'No saved locations found' : 'Can\'t find your place?';
                fallbackText.appendChild(fallbackName);
                fallbackText.appendChild(fallbackPath);
                fallback.appendChild(fallbackIcon);
                fallback.appendChild(fallbackText);
                fallback.addEventListener('click', () => {
                    searchResultsEl.classList.remove('open');
                    searchGooglePlaces(query);
                });
                searchResultsEl.appendChild(fallback);
                searchResultsEl.classList.add('open');
            }

            async function searchGooglePlaces(query) {
                updateStatus('Searching Google Maps...');
                try {
                    const { Place } = await google.maps.importLibrary('places');
                    const request = {
                        textQuery: query + ' India',
                        fields: ['displayName', 'location'],
                        maxResultCount: 1
                    };
                    const { places } = await Place.searchByText(request);
                    if (places && places.length > 0) {
                        const place = places[0];
                        markers.forEach(m => m.setMap(null));
                        markers = [];
                        const marker = new google.maps.Marker({
                            map: map,
                            title: place.displayName,
                            position: place.location
                        });
                        markers.push(marker);
                        zoomBypassActive = true;
                        map.setCenter(place.location);
                        map.setZoom(MAX_FREE_ZOOM - 1);
                        google.maps.event.addListenerOnce(map, 'idle', () => { zoomBypassActive = false; });
                        searchInput.value = place.displayName;
                        updateStatus('Found: ' + place.displayName);
                    } else {
                        updateStatus('No results found for "' + query + '"');
                    }
                } catch (e) {
                    console.error('Places search error:', e);
                    updateStatus('Search failed. Please try again.');
                }
            }

            // Wire up real-time sidebar refresh for purchase updates
            refreshSidebarIfOpen = function() {
                if (sidebarHistory.length > 0 && sidebarPanel.classList.contains('open')) {
                    const current = sidebarHistory[sidebarHistory.length - 1];
                    renderSidebarList(current.items, current.type);
                }
            };
        }

        // ---------------- Coordinate parsers (shared by dialog + search auto-detect) ----------------

        // Parse one lat or lng expressed in DMS-like form.
        // Accepts: "18.5204" | "18 31 13.4 N" | "18°31'13.4\"N" | "-18 31 13.4" | "N 18 31 13.4"
        // Returns the signed decimal degree value, or null if unparseable / out of DMS ranges.
        function parseDMSValue(raw) {
            if (raw == null) return null;
            const s = String(raw).trim();
            if (!s) return null;
            const dirMatch = s.match(/[NSEWnsew]/);
            const dir = dirMatch ? dirMatch[0].toUpperCase() : null;
            // Replace symbols/letters with spaces, then tokenize numbers (keep minus signs).
            const cleaned = s.replace(/[°'"dms\u00B0NSEWnsew,]/g, ' ').replace(/\s+/g, ' ').trim();
            if (!cleaned) return null;
            const tokens = cleaned.split(' ').filter(Boolean);
            const nums = tokens.map(t => parseFloat(t)).filter(n => !isNaN(n));
            if (nums.length === 0) return null;
            const deg = nums[0];
            const min = nums.length > 1 ? nums[1] : 0;
            const sec = nums.length > 2 ? nums[2] : 0;
            if (min < 0 || min >= 60) return null;
            if (sec < 0 || sec >= 60) return null;
            const negative = deg < 0;
            let val = Math.abs(deg) + min / 60 + sec / 3600;
            if (negative) val = -val;
            if (dir === 'S' || dir === 'W') val = -Math.abs(val);
            else if (dir === 'N' || dir === 'E') val = Math.abs(val);
            return val;
        }

        // WGS84 UTM -> Lat/Lng (ported from androidGISProject/UTMConverter.kt)
        function utmToLatLng(zone, hemisphere, easting, northing) {
            const a = 6378137.0;
            const f = 1.0 / 298.257223563;
            const b = a * (1 - f);
            const e = Math.sqrt(1 - (b * b) / (a * a));
            const e2 = e * e;
            const ep2 = e2 / (1 - e2);
            const k0 = 0.9996;

            const x = easting - 500000.0;
            let y = northing;
            if (hemisphere === 'S') y -= 10000000.0;

            const lon0 = (zone - 1) * 6 - 180 + 3;
            const lon0Rad = lon0 * Math.PI / 180;

            const M = y / k0;
            const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
            const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

            const phi1 = mu
                + (3 * e1 / 2 - 27 * e1 * e1 * e1 / 32) * Math.sin(2 * mu)
                + (21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 32) * Math.sin(4 * mu)
                + (151 * e1 * e1 * e1 / 96) * Math.sin(6 * mu)
                + (1097 * e1 * e1 * e1 * e1 / 512) * Math.sin(8 * mu);

            const sinPhi1 = Math.sin(phi1);
            const cosPhi1 = Math.cos(phi1);
            const tanPhi1 = Math.tan(phi1);
            const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
            const T1 = tanPhi1 * tanPhi1;
            const C1 = ep2 * cosPhi1 * cosPhi1;
            const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
            const D = x / (N1 * k0);

            const lat = phi1 - (N1 * tanPhi1 / R1) * (D * D / 2
                - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24
                + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);

            const lng = lon0Rad + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6
                + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / cosPhi1;

            return { lat: lat * 180 / Math.PI, lng: lng * 180 / Math.PI };
        }

        // Detect coordinates inside a free-form search query.
        // Returns {lat,lng,label} if the whole query is a coord pair, else null.
        function detectCoordsInQuery(q) {
            if (!q) return null;
            const s = q.trim();
            if (!s) return null;

            // 1) Pure decimal pair: "18.5204, 73.8567" or "18.52 73.86" or "-18.5, -73.8"
            const decMatch = s.match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/);
            if (decMatch) {
                const lat = parseFloat(decMatch[1]);
                const lng = parseFloat(decMatch[2]);
                if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                    return { lat: lat, lng: lng, label: lat.toFixed(6) + ', ' + lng.toFixed(6) };
                }
            }

            // 2) DMS pair: contains °'" or N/S + E/W letters and at least two numbers each side.
            if (/[°'"]/.test(s) || (/[NSns]/.test(s) && /[EWew]/.test(s))) {
                // Split into two halves. Try comma first; otherwise split at E/W boundary or N/S boundary.
                let halves = null;
                if (s.includes(',')) {
                    halves = s.split(',', 2);
                } else {
                    // Split after N/S direction letter
                    const m = s.match(/^(.+?[NSns])\s+(.+)$/);
                    if (m) halves = [m[1], m[2]];
                }
                if (halves && halves.length === 2) {
                    const lat = parseDMSValue(halves[0]);
                    const lng = parseDMSValue(halves[1]);
                    if (lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                        return { lat: lat, lng: lng, label: lat.toFixed(6) + ', ' + lng.toFixed(6) };
                    }
                }
            }

            return null;
        }

        // Navigate the map to a coordinate (reuses goToLocation behaviour).
        function goToCoordinate(lat, lng, label) {
            if (typeof goToLocation === 'function') {
                goToLocation(lat, lng, label || (lat.toFixed(6) + ', ' + lng.toFixed(6)), '');
            } else if (typeof map !== 'undefined' && map) {
                map.setCenter({ lat: lat, lng: lng });
                map.setZoom(15);
            }
            // Drop a marker at the destination for visual reference
            if (typeof markers !== 'undefined' && typeof google !== 'undefined') {
                try {
                    markers.forEach(m => m.setMap(null));
                    markers.length = 0;
                    const mk = new google.maps.Marker({ map: map, position: { lat: lat, lng: lng }, title: label });
                    markers.push(mk);
                } catch (e) { /* marker is optional */ }
            }
        }

        function initUIEvents() {
            // Map type control
            document.getElementById('map-type').addEventListener('change', function() {
                map.setMapTypeId(this.value);
            });

            // Home button — back to MapMagician landing page.
            // mapmagician.in keeps the original marketing-index behavior. Every other
            // host (dpplans.com in production, localhost during local dpplans-seo testing)
            // goes to /home/, the regions-browser landing.
            document.getElementById('btn-home').addEventListener('click', () => {
                var onMapMagician = location.hostname.indexOf('mapmagician.in') !== -1;
                window.location.href = onMapMagician ? 'index.html' : '/home/';
            });

            // ---------------- Go to Coordinates dialog ----------------
            const coordOverlay = document.getElementById('coord-dialog-overlay');
            const coordErr = document.getElementById('coord-error');
            const coordTabs = coordOverlay.querySelectorAll('.coord-tab');
            const coordPanels = {
                decimal: document.getElementById('coord-panel-decimal'),
                dms: document.getElementById('coord-panel-dms'),
                utm: document.getElementById('coord-panel-utm')
            };
            let activeCoordTab = 'decimal';

            function setCoordTab(name) {
                if (!coordPanels[name]) return;
                activeCoordTab = name;
                coordTabs.forEach(t => t.classList.toggle('active', t.dataset.coordTab === name));
                Object.keys(coordPanels).forEach(k => { coordPanels[k].style.display = (k === name) ? 'flex' : 'none'; });
                coordErr.textContent = '';
            }

            function openCoordDialog(preselectTab, prefill) {
                coordErr.textContent = '';
                if (preselectTab) setCoordTab(preselectTab);
                if (prefill) {
                    if (prefill.decLat != null) document.getElementById('coord-dec-lat').value = prefill.decLat;
                    if (prefill.decLng != null) document.getElementById('coord-dec-lng').value = prefill.decLng;
                }
                coordOverlay.classList.add('open');
                // Focus first input of active panel
                setTimeout(() => {
                    const panel = coordPanels[activeCoordTab];
                    const first = panel && panel.querySelector('input');
                    if (first) first.focus();
                }, 50);
            }

            function closeCoordDialog() {
                coordOverlay.classList.remove('open');
                coordErr.textContent = '';
            }

            window.openCoordDialog = openCoordDialog; // exposed for search dropdown

            coordTabs.forEach(t => t.addEventListener('click', () => setCoordTab(t.dataset.coordTab)));

            // Wire DMS N/S and E/W toggle buttons (only one active per group)
            coordOverlay.querySelectorAll('.coord-dir-toggle').forEach(group => {
                group.querySelectorAll('.coord-dir-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        group.querySelectorAll('.coord-dir-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                    });
                });
            });

            document.getElementById('coord-btn-search').addEventListener('click', () => openCoordDialog('decimal'));
            document.getElementById('coord-cancel').addEventListener('click', closeCoordDialog);
            coordOverlay.addEventListener('click', (e) => { if (e.target === coordOverlay) closeCoordDialog(); });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && coordOverlay.classList.contains('open')) closeCoordDialog();
            });

            function submitCoordDialog() {
                coordErr.textContent = '';
                let lat = null, lng = null;
                if (activeCoordTab === 'decimal') {
                    const latStr = document.getElementById('coord-dec-lat').value.trim();
                    const lngStr = document.getElementById('coord-dec-lng').value.trim();
                    // Allow the user to paste "lat, lng" into the lat field
                    if (latStr && !lngStr && /[,\s]/.test(latStr)) {
                        const parts = latStr.split(/[,\s]+/).filter(Boolean);
                        if (parts.length >= 2) {
                            lat = parseFloat(parts[0]); lng = parseFloat(parts[1]);
                        }
                    } else {
                        lat = parseFloat(latStr); lng = parseFloat(lngStr);
                    }
                    if (isNaN(lat) || isNaN(lng)) { coordErr.textContent = 'Enter valid decimal numbers.'; return; }
                    if (lat < -90 || lat > 90) { coordErr.textContent = 'Latitude must be between -90 and 90.'; return; }
                    if (lng < -180 || lng > 180) { coordErr.textContent = 'Longitude must be between -180 and 180.'; return; }
                } else if (activeCoordTab === 'dms') {
                    const latDeg = document.getElementById('coord-dms-lat-deg').value.trim();
                    const latMin = document.getElementById('coord-dms-lat-min').value.trim();
                    const latSec = document.getElementById('coord-dms-lat-sec').value.trim();
                    const lngDeg = document.getElementById('coord-dms-lng-deg').value.trim();
                    const lngMin = document.getElementById('coord-dms-lng-min').value.trim();
                    const lngSec = document.getElementById('coord-dms-lng-sec').value.trim();
                    const latDirBtn = coordOverlay.querySelector('.coord-dir-toggle[data-dir-group="lat"] .coord-dir-btn.active');
                    const lngDirBtn = coordOverlay.querySelector('.coord-dir-toggle[data-dir-group="lng"] .coord-dir-btn.active');
                    if (!latDeg) { coordErr.textContent = 'Enter latitude degrees.'; return; }
                    if (!lngDeg) { coordErr.textContent = 'Enter longitude degrees.'; return; }
                    const latDir = latDirBtn ? latDirBtn.dataset.dir : 'N';
                    const lngDir = lngDirBtn ? lngDirBtn.dataset.dir : 'E';
                    lat = parseDMSValue(latDeg + ' ' + (latMin || '0') + ' ' + (latSec || '0') + ' ' + latDir);
                    lng = parseDMSValue(lngDeg + ' ' + (lngMin || '0') + ' ' + (lngSec || '0') + ' ' + lngDir);
                    if (lat === null || lng === null) { coordErr.textContent = 'Enter valid DMS values (min/sec 0-59).'; return; }
                    if (lat < -90 || lat > 90) { coordErr.textContent = 'Latitude out of range (0-90).'; return; }
                    if (lng < -180 || lng > 180) { coordErr.textContent = 'Longitude out of range (0-180).'; return; }
                } else if (activeCoordTab === 'utm') {
                    const zone = parseInt(document.getElementById('coord-utm-zone').value, 10);
                    const hemi = document.getElementById('coord-utm-hemi').value;
                    const easting = parseFloat(document.getElementById('coord-utm-easting').value);
                    const northing = parseFloat(document.getElementById('coord-utm-northing').value);
                    if (isNaN(zone) || zone < 1 || zone > 60) { coordErr.textContent = 'Zone must be between 1 and 60.'; return; }
                    if (hemi !== 'N' && hemi !== 'S') { coordErr.textContent = 'Select hemisphere (N or S).'; return; }
                    if (isNaN(easting) || easting < 100000 || easting > 900000) { coordErr.textContent = 'Easting must be 100000 – 900000.'; return; }
                    if (isNaN(northing) || northing < 0 || northing > 10000000) { coordErr.textContent = 'Northing must be 0 – 10000000.'; return; }
                    const res = utmToLatLng(zone, hemi, easting, northing);
                    lat = res.lat; lng = res.lng;
                    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { coordErr.textContent = 'Converted coordinate is out of range.'; return; }
                }
                goToCoordinate(lat, lng, lat.toFixed(6) + ', ' + lng.toFixed(6));
                closeCoordDialog();
            }

            document.getElementById('coord-go').addEventListener('click', submitCoordDialog);
            // Enter key inside any input submits
            coordOverlay.querySelectorAll('input').forEach(inp => {
                inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCoordDialog(); } });
            });

            // Layer panel open/close
            // Settings panel open/close
            const settingsPanel = document.getElementById('settings-panel');
            const settingsOverlay = document.getElementById('settings-overlay');
            function makeExpandableGroup(title, color, count, items) {
                var wrap = document.createElement('div');
                wrap.style.cssText = 'margin-bottom:8px;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;';

                var header = document.createElement('div');
                header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#fafafa;cursor:pointer;user-select:none;';
                header.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">' +
                    '<span style="font-size:12px;font-weight:700;color:' + color + ';text-transform:uppercase;letter-spacing:0.5px;">' + title + '</span>' +
                    '<span style="font-size:11px;background:#e0e0e0;color:#555;padding:1px 6px;border-radius:8px;">' + count + '</span></div>' +
                    '<span class="expand-arrow" style="font-size:14px;color:#999;transition:transform 0.2s;">&#9660;</span>';

                var body = document.createElement('div');
                body.style.cssText = 'display:none;padding:6px 8px 8px;';

                if (items.length === 0) {
                    body.innerHTML = '<div style="font-size:12px;color:#999;padding:4px 4px;">No active purchases</div>';
                } else {
                    items.forEach(function(item) {
                        var row = document.createElement('div');
                        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#f5f5f5;border-radius:8px;margin-bottom:4px;font-size:13px;';
                        row.innerHTML = item.html;
                        // Optional row click: navigate the map to the purchased region.
                        // Skips the click if the user actually tapped an interactive
                        // element inside (e.g. the subscription Cancel button).
                        if (typeof item.onClick === 'function') {
                            row.style.cursor = 'pointer';
                            row.addEventListener('click', function(e) {
                                if (e.target && e.target.closest && e.target.closest('button')) return;
                                item.onClick();
                            });
                        }
                        body.appendChild(row);
                    });
                }

                header.addEventListener('click', function() {
                    var isOpen = body.style.display !== 'none';
                    body.style.display = isOpen ? 'none' : 'block';
                    header.querySelector('.expand-arrow').style.transform = isOpen ? '' : 'rotate(180deg)';
                });

                wrap.appendChild(header);
                wrap.appendChild(body);
                return wrap;
            }

            window.renderSettingsPurchases = renderSettingsPurchases;
            function renderSettingsPurchases() {
                var section = document.getElementById('settings-purchases-section');
                var subDiv = document.getElementById('settings-sub-purchases');
                var dpDiv = document.getElementById('settings-dp-purchases');
                var androidDiv = document.getElementById('settings-android-purchases');
                var villDiv = document.getElementById('settings-village-purchases');

                if (!currentUser || currentUser.isAnonymous) {
                    section.style.display = 'none';
                    return;
                }

                subDiv.innerHTML = '';
                dpDiv.innerHTML = '';
                androidDiv.innerHTML = '';
                villDiv.innerHTML = '';

                function calcDaysLeft(expiry) {
                    var ms = Math.max(0, expiry - Date.now());
                    var d = Math.floor(ms / 86400000);
                    var h = Math.floor((ms % 86400000) / 3600000);
                    var m = Math.floor((ms % 3600000) / 60000);
                    if (d > 0) return d + 'd ' + h + 'h';
                    if (h > 0) return h + 'h ' + m + 'm';
                    return m + 'm';
                }

                // Navigate the map to the centre of a purchased district / region.
                // Uses the first village in the district's villagesJSON as the
                // representative centre, then lets goToLocation() handle the pan/zoom.
                function goToPurchasedRegion(pid) {
                    if (!pid || !menuData || menuData.length === 0) return false;
                    var want = pid.toLowerCase().replace(/gst$/, '');
                    var wantNoPrefix = want.replace(/^district/, '');
                    for (var i = 0; i < menuData.length; i++) {
                        var m = menuData[i];
                        if (!m.productPurchaseID) continue;
                        var mpid = m.productPurchaseID.toLowerCase().replace(/gst$/, '');
                        var mpidNoPrefix = mpid.replace(/^district/, '');
                        if (mpid === want || mpidNoPrefix === wantNoPrefix) {
                            var villages = parseVillagesJSON(m.villagesJSON);
                            if (villages.length > 0) {
                                var centre = villages[0];
                                closeSettingsPanel();
                                goToLocation(centre.lat, centre.lng, m.district || m.state || 'Region', m.productPurchaseID);
                                return true;
                            }
                            break;
                        }
                    }
                    return false;
                }

                // Navigate the map to a purchased village by its name.
                function goToPurchasedVillage(vName) {
                    if (!vName) return false;
                    var item = villageDataByName && villageDataByName.get(vName);
                    if (!item && typeof villageLayerData !== 'undefined' && villageLayerData) {
                        for (var i = 0; i < villageLayerData.length; i++) {
                            if (villageLayerData[i] && villageLayerData[i].villageName === vName) {
                                item = villageLayerData[i];
                                break;
                            }
                        }
                    }
                    if (item) {
                        var centre = getVillageCenter(item);
                        if (centre) {
                            closeSettingsPanel();
                            goToLocation(centre.lat, centre.lng, vName, '');
                            return true;
                        }
                    }
                    return false;
                }

                // Split purchases into categories
                var subItems = [];
                var dpItems = [];
                var androidItems = [];

                activePurchases.forEach(function(val, pid) {
                    var district = findDistrictByPurchaseId(pid);
                    var name = district ? district.districtName : pid;

                    // Capture pid for the onClick closure.
                    var regionPid = pid;
                    var gotoHandler = function() { goToPurchasedRegion(regionPid); };

                    // Refunded entry — show with badge, no days left
                    if (val.refunded) {
                        var planLabel = val.plan === 'subscription' ? 'Subscription' : val.plan === 'professional' ? 'Pro Pass' : val.plan === 'web' ? 'Web Pass' : val.plan === 'override' ? 'Override' : '7-Day Pass';
                        var targetArr = val.plan === 'subscription' ? subItems : val.plan === 'professional' ? androidItems : dpItems;
                        targetArr.push({
                            _order: 9, // refunded always sinks to the bottom of its group
                            html: '<div style="flex:1;min-width:0;">' +
                                '<div style="font-weight:600;color:#999;text-decoration:line-through;">' + name + '</div>' +
                                '<div style="font-size:11px;color:#888;">' + planLabel + '</div>' +
                            '</div>' +
                            '<span style="font-size:10px;font-weight:600;color:#c62828;background:#FFEBEE;padding:2px 8px;border-radius:4px;">Refunded</span>',
                            onClick: gotoHandler
                        });
                        return;
                    }

                    var daysLeft = calcDaysLeft(val.expiry);
                    var daysColor = (val.expiry - Date.now()) < 86400000 ? '#c62828' : '#2E7D32';

                    if (val.plan === 'subscription') {
                        // Subscription — show status + cancel button
                        var sub = activeSubscriptions.get(pid);
                        var status = sub ? sub.status : 'active';
                        if (status === 'paused') status = 'cancelled'; // paused subs are treated as ended (backend collapses them too)
                        var statusColor = status === 'active' ? '#2E7D32' : status === 'cancelled' ? '#c62828' : '#EF6C00';
                        var statusLabel = status === 'active' ? 'Active' : status === 'cancelled' ? 'Cancelled' : status === 'halted' ? 'Payment Failed' : status.charAt(0).toUpperCase() + status.slice(1);

                        var inGrace = !!(sub && sub.graceAppliedThisCycle
                            && Number(sub.graceExpiry || 0) > Date.now());
                        // Renew is offered for any recoverable state (grace /
                        // halted / pending), matching the backend gate.
                        var needsRenew = inGrace || status === 'halted' || status === 'pending';

                        var btns = [];
                        if (needsRenew) {
                            btns.push('<button onclick="renewRegionSubscription(\'' + pid + '\', \'' + name.replace(/'/g, "\\'") + '\')" ' +
                                'style="padding:3px 10px;font-size:10px;font-weight:600;border:1px solid #2E7D32;color:#fff;background:#2E7D32;border-radius:4px;cursor:pointer;">Renew</button>');
                        }
                        if (status === 'active' || needsRenew) {
                            btns.push('<button onclick="cancelRegionSubscription(\'' + pid + '\', \'' + name.replace(/'/g, "\\'") + '\')" ' +
                                'style="padding:3px 10px;font-size:10px;font-weight:600;border:1px solid #c62828;color:#c62828;background:none;border-radius:4px;cursor:pointer;">Cancel</button>');
                        }
                        var cancelBtn = btns.length
                            ? '<div style="display:flex;gap:6px;margin-top:4px;">' + btns.join('') + '</div>'
                            : '';

                        // Ordering within Subscriptions: healthy first, terminal last
                        var statusOrder = status === 'active' ? 0 :
                                          status === 'halted' ? 1 :
                                          status === 'paused' ? 2 :
                                          status === 'completed' ? 4 :
                                          status === 'cancelled' ? 5 : 3;

                        subItems.push({
                            _order: statusOrder,
                            html: '<div style="flex:1;min-width:0;">' +
                                '<div style="font-weight:600;color:#333;">' + name + '</div>' +
                                '<div style="display:flex;align-items:center;gap:6px;margin-top:2px;">' +
                                    '<span style="font-size:10px;font-weight:600;color:#fff;background:' + statusColor + ';padding:1px 6px;border-radius:4px;">' + statusLabel + '</span>' +
                                    '<span style="font-size:11px;color:#888;">' + (function() { if (!sub || !sub.currentPeriodStart || !sub.currentPeriodEnd) return 'Weekly'; var days = Math.round((sub.currentPeriodEnd - sub.currentPeriodStart) / 86400000); return days <= 1 ? 'Daily' : days <= 7 ? 'Weekly' : days <= 31 ? 'Monthly' : days + '-Day'; })() + '</span>' +
                                '</div>' +
                                cancelBtn +
                            '</div>' +
                            '<span style="font-size:11px;font-weight:600;color:' + daysColor + ';" title="Subscriptions renew at the start of the day">' + formatSubscriptionCountdown(val.expiry, sub && sub.status) + '</span>',
                            onClick: gotoHandler
                        });
                    } else if (val.plan === 'professional') {
                        androidItems.push({
                            html: '<div style="flex:1;min-width:0;"><div style="font-weight:600;color:#333;">' + name + '</div><div style="font-size:11px;color:#888;">Pro Pass</div></div>' +
                                '<span style="font-size:11px;font-weight:600;color:' + daysColor + ';">' + daysLeft + ' left</span>',
                            onClick: gotoHandler
                        });
                    } else if (val.plan === 'web') {
                        dpItems.push({
                            html: '<div style="flex:1;min-width:0;"><div style="font-weight:600;color:#333;">' + name + '</div><div style="font-size:11px;color:#888;">Web Pass</div></div>' +
                                '<span style="font-size:11px;font-weight:600;color:' + daysColor + ';">' + daysLeft + ' left</span>',
                            onClick: gotoHandler
                        });
                    } else if (val.plan === 'override') {
                        dpItems.push({
                            html: '<div style="flex:1;min-width:0;"><div style="font-weight:600;color:#333;">' + name + '</div><div style="font-size:11px;color:#888;">Override</div></div>' +
                                '<span style="font-size:11px;font-weight:600;color:' + daysColor + ';">' + daysLeft + ' left</span>',
                            onClick: gotoHandler
                        });
                    } else {
                        // Default: 7-Day Pass (empty plan or unknown)
                        dpItems.push({
                            html: '<div style="flex:1;min-width:0;"><div style="font-weight:600;color:#333;">' + name + '</div><div style="font-size:11px;color:#888;">7-Day Pass</div></div>' +
                                '<span style="font-size:11px;font-weight:600;color:' + daysColor + ';">' + daysLeft + ' left</span>',
                            onClick: gotoHandler
                        });
                    }
                });

                // Recoverable subscriptions with NO purchase entry — a halted
                // sub's mirror gets expiry-revoked then deleted by
                // cleanupMyExpiredPurchases, so it never appears via
                // activePurchases above and the Subscriptions group would be
                // empty. Synthesize a row (status + Renew/Cancel) for any
                // recoverable sub (halted/pending/grace) that has no purchase
                // entry, so the customer can still see and renew it.
                activeSubscriptions.forEach(function(sub, pid) {
                    if (!sub || activePurchases.has(pid)) return;
                    var sStatus = sub.status;
                    var sInGrace = !!(sub.graceAppliedThisCycle
                        && Number(sub.graceExpiry || 0) > Date.now());
                    var sNeedsRenew = sInGrace || sStatus === 'halted' || sStatus === 'pending';
                    if (!sNeedsRenew) return;
                    var sDistrict = findDistrictByPurchaseId(pid);
                    var sName = sDistrict ? sDistrict.districtName : pid;
                    var sPid = pid;
                    var sNameEsc = sName.replace(/'/g, "\\'");
                    var sLabel = sStatus === 'halted' ? 'Payment Failed'
                        : sStatus === 'pending' ? 'Payment Pending'
                        : sStatus.charAt(0).toUpperCase() + sStatus.slice(1);
                    var sBtns = '<button onclick="renewRegionSubscription(\'' + sPid + '\', \'' + sNameEsc + '\')" '
                        + 'style="padding:3px 10px;font-size:10px;font-weight:600;border:1px solid #2E7D32;color:#fff;background:#2E7D32;border-radius:4px;cursor:pointer;">Renew</button>'
                        + '<button onclick="cancelRegionSubscription(\'' + sPid + '\', \'' + sNameEsc + '\')" '
                        + 'style="padding:3px 10px;font-size:10px;font-weight:600;border:1px solid #c62828;color:#c62828;background:none;border-radius:4px;cursor:pointer;">Cancel</button>';
                    subItems.push({
                        _order: sStatus === 'halted' ? 1 : 3,
                        html: '<div style="flex:1;min-width:0;">'
                            + '<div style="font-weight:600;color:#333;">' + sName + '</div>'
                            + '<div style="display:flex;align-items:center;gap:6px;margin-top:2px;">'
                            + '<span style="font-size:10px;font-weight:600;color:#fff;background:#EF6C00;padding:1px 6px;border-radius:4px;">' + sLabel + '</span>'
                            + '<span style="font-size:11px;color:#888;">Weekly</span>'
                            + '</div>'
                            + '<div style="display:flex;gap:6px;margin-top:4px;">' + sBtns + '</div>'
                            + '</div>',
                        onClick: function() { goToPurchasedRegion(sPid); }
                    });
                });

                // Stable sort each group so active entries rise to the top and
                // terminal states (cancelled, refunded) sink to the bottom.
                // Items pushed without _order default to 0 (treated as active).
                var byOrder = function(a, b) { return (a._order || 0) - (b._order || 0); };
                subItems.sort(byOrder);
                dpItems.sort(byOrder);
                androidItems.sort(byOrder);

                // Subscriptions group
                if (subItems.length > 0) {
                    subDiv.appendChild(makeExpandableGroup('Subscriptions', '#6A1B9A', subItems.length, subItems));
                }

                // Web / 7-Day Pass group
                if (dpItems.length > 0) {
                    dpDiv.appendChild(makeExpandableGroup('7-Day Pass', '#00796B', dpItems.length, dpItems));
                }

                // Android / Pro purchases
                if (androidItems.length > 0) {
                    androidDiv.appendChild(makeExpandableGroup('Android Purchases', '#E65100', androidItems.length, androidItems));
                }

                // Village purchases
                var villItems = [];
                villagePurchases.forEach(function(val, vName) {
                    var daysLeft = calcDaysLeft(val.expiry);
                    var capturedName = vName;
                    villItems.push({
                        html: '<div style="font-weight:600;color:#333;">' + vName + '</div>' +
                            '<span style="font-size:11px;font-weight:600;color:' + ((val.expiry - Date.now()) < 86400000 ? '#c62828' : '#2E7D32') + ';">' + daysLeft + ' left</span>',
                        onClick: function() { goToPurchasedVillage(capturedName); }
                    });
                });
                villDiv.appendChild(makeExpandableGroup('Village Add-On Plans', '#1565C0', villItems.length, villItems));

                section.style.display = 'block';
                document.getElementById('settings-no-purchases').style.display = 'none';
            }

            // ── Purchase History ──
            var histDiv = document.getElementById('settings-purchase-history');
            histDiv.innerHTML = '';
            if (purchaseHistory.length > 0) {
                var histItems = [];
                var dateFmt = function(ts) {
                    if (!ts) return '';
                    var d = new Date(ts);
                    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
                };
                purchaseHistory.forEach(function(h) {
                    var eventLabel, badgeColor, badgeBg;
                    switch (h.event) {
                        case 'purchase': eventLabel = 'Purchased'; badgeColor = '#2E7D32'; badgeBg = '#E8F5E9'; break;
                        case 'subscription_started': eventLabel = 'Subscribed'; badgeColor = '#6A1B9A'; badgeBg = '#F3E5F5'; break;
                        case 'cancelled': eventLabel = 'Cancelled'; badgeColor = '#E65100'; badgeBg = '#FFF3E0'; break;
                        case 'refund': eventLabel = 'Refunded'; badgeColor = '#c62828'; badgeBg = '#FFEBEE'; break;
                        default: eventLabel = h.event || 'Unknown'; badgeColor = '#666'; badgeBg = '#F5F5F5';
                    }
                    var name = h.regionName || h.productId || '';
                    var amountStr = h.amount ? ' — ₹' + h.amount : '';
                    histItems.push({
                        html: '<div style="display:flex;align-items:center;gap:8px;">' +
                            '<span style="font-size:10px;font-weight:600;color:' + badgeColor + ';background:' + badgeBg + ';padding:2px 8px;border-radius:4px;">' + eventLabel + '</span>' +
                            '<span style="font-weight:600;color:#333;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</span>' +
                        '</div>' +
                        '<div style="font-size:11px;color:#888;margin-top:2px;">' + dateFmt(h.timestamp) + amountStr + '</div>'
                    });
                });
                histDiv.appendChild(makeExpandableGroup('Purchase History', '#78909C', histItems.length, histItems));
                section.style.display = 'block';
            }

            document.getElementById('btn-settings').addEventListener('click', function() {
                settingsPanel.classList.add('open');
                settingsOverlay.classList.add('open');
                renderSettingsPurchases();
                // Hide floating sign-in button while settings is open
                var fsb = document.getElementById('floating-signin-btn');
                if (fsb) fsb.style.display = 'none';
            });

            // Plan card carousel: update dots + arrow visibility on scroll
            var pdScroll = document.getElementById('pd-cards-scroll');
            if (pdScroll) {
                pdScroll.addEventListener('scroll', function() {
                    var scrollLeft = pdScroll.scrollLeft;
                    var cardWidth = pdScroll.querySelector('.pd-plan-card')?.offsetWidth || 260;
                    var idx = Math.round(scrollLeft / (cardWidth + 12));
                    var dot0 = document.getElementById('pd-dot-0');
                    var dot1 = document.getElementById('pd-dot-1');
                    if (dot0 && dot1) {
                        dot0.className = idx === 0 ? 'pd-dot pd-dot-active' : 'pd-dot';
                        dot1.className = idx >= 1 ? 'pd-dot pd-dot-active' : 'pd-dot';
                    }
                });
            }
            function closeSettingsPanel() {
                settingsPanel.classList.remove('open');
                settingsOverlay.classList.remove('open');
                // Restore floating sign-in button if not signed in
                var fsb = document.getElementById('floating-signin-btn');
                if (fsb && (!currentUser || currentUser.isAnonymous)) fsb.style.display = 'flex';
            }
            document.getElementById('settings-panel-close').addEventListener('click', closeSettingsPanel);
            settingsOverlay.addEventListener('click', closeSettingsPanel);
            // Settings panel account buttons
            document.getElementById('settings-signin-btn').addEventListener('click', function() {
                closeSettingsPanel();
                triggerGoogleSignIn();
            });
            document.getElementById('settings-signout-btn').addEventListener('click', function() {
                closeSettingsPanel();
                document.getElementById('signout-dialog-overlay').classList.add('open');
            });

            document.getElementById('settings-share-btn').addEventListener('click', function() {
                var shareData = {
                    title: 'Development Plan GIS - MapMagician',
                    text: 'View development plan maps overlaid on satellite imagery.',
                    url: 'https://maps.mapmagician.in'
                };
                if (navigator.share) {
                    navigator.share(shareData).catch(function() {});
                } else if (navigator.clipboard) {
                    navigator.clipboard.writeText(shareData.url).then(function() {
                        alert('Link copied to clipboard!');
                    });
                }
                closeSettingsPanel();
            });
            document.getElementById('settings-install-btn').addEventListener('click', function() {
                closeSettingsPanel();
                openInstallInfo();
            });

            // Stamp the running JS version into the Settings header (see APP_VERSION above).
            var _verEl = document.getElementById('settings-version');
            if (_verEl) _verEl.textContent = ': Ver -' + APP_VERSION;

            document.getElementById('settings-contact-support').addEventListener('click', function() {
                closeSettingsPanel();
                openSupportForm(null, false);
            });
            document.getElementById('settings-clear-cache').addEventListener('click', function() {
                closeSettingsPanel();
                Promise.all([
                    caches.keys().then(function(names) {
                        return Promise.all(names.map(function(n) { return caches.delete(n); }));
                    }),
                    navigator.serviceWorker.getRegistrations().then(function(regs) {
                        return Promise.all(regs.map(function(r) { return r.unregister(); }));
                    }),
                    new Promise(function(resolve) {
                        var req = indexedDB.deleteDatabase('mapmagician_geojson');
                        req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve;
                    }),
                    new Promise(function(resolve) {
                        var req = indexedDB.deleteDatabase('mapmagician_tiles');
                        req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve;
                    }),
                    new Promise(function(resolve) {
                        try {
                            localStorage.removeItem('layer_dp');
                            localStorage.removeItem('layer_village');
                            localStorage.removeItem('layer_olddp');
                            localStorage.removeItem('solapur_overlay_v1');
                            localStorage.removeItem('layer_district_bbox');
                            // Stale entry from removed reverseGeocodeDistrict path —
                            // sweep on existing users so the key doesn't linger.
                            localStorage.removeItem('geocoder_cache');
                        } catch(e) {}
                        resolve();
                    })
                ]).then(function() {
                    alert('Cache cleared! The page will reload.');
                    location.reload(true);
                }).catch(function() {
                    alert('Cache cleared! The page will reload.');
                    location.reload(true);
                });
            });

            // Layer panel open/close
            const layerPanel = document.getElementById('layer-panel');
            const layerOverlay = document.getElementById('layer-overlay');
            document.getElementById('btn-layers').addEventListener('click', function() {
                layerPanel.classList.add('open');
                layerOverlay.classList.add('open');
            });
            function closeLayerPanel() {
                layerPanel.classList.remove('open');
                layerOverlay.classList.remove('open');
            }
            document.getElementById('layer-panel-close').addEventListener('click', closeLayerPanel);
            layerOverlay.addEventListener('click', closeLayerPanel);

            // GPS button — continuous location tracking (3-state: off → following → tracking → off)
            let gpsWatchId = null;
            let gpsMarker = null;
            let gpsAccuracyCircle = null;
            let gpsHeadingMarker = null;
            let gpsFollowing = false;   // true = auto-center map on updates
            let gpsPanListener = null;  // listener to detect user pan
            const gpsBtn = document.getElementById('btn-gps');

            function setGpsButtonState(state) {
                gpsBtn.classList.remove('gps-following', 'gps-tracking');
                if (state === 'following') gpsBtn.classList.add('gps-following');
                else if (state === 'tracking') gpsBtn.classList.add('gps-tracking');
            }

            function stopGpsTracking() {
                if (gpsWatchId !== null) {
                    navigator.geolocation.clearWatch(gpsWatchId);
                    gpsWatchId = null;
                }
                if (gpsMarker) { gpsMarker.setMap(null); gpsMarker = null; }
                if (gpsAccuracyCircle) { gpsAccuracyCircle.setMap(null); gpsAccuracyCircle = null; }
                if (gpsHeadingMarker) { gpsHeadingMarker.setMap(null); gpsHeadingMarker = null; }
                if (gpsPanListener) { google.maps.event.removeListener(gpsPanListener); gpsPanListener = null; }
                gpsFollowing = false;
                setGpsButtonState('off');
            }

            let gpsToastTimer = null;
            function showGpsToast(text, color) {
                const toast = document.getElementById('unlock-toast');
                const icon = toast.querySelector('svg');
                document.getElementById('unlock-toast-text').textContent = text;
                toast.style.background = color || '#2E7D32';
                toast.classList.add('show');
                if (gpsToastTimer) clearTimeout(gpsToastTimer);
                gpsToastTimer = setTimeout(function() { toast.classList.remove('show'); }, 3000);
            }

            function startGpsTracking() {
                gpsFollowing = true;
                setGpsButtonState('following');
                showGpsToast('Locating...', '#1976D2');

                // Detect user pan to switch from following → tracking
                gpsPanListener = map.addListener('dragstart', function() {
                    if (gpsWatchId !== null && gpsFollowing) {
                        gpsFollowing = false;
                        setGpsButtonState('tracking');
                    }
                });

                gpsWatchId = navigator.geolocation.watchPosition(function(pos) {
                    const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                    const accuracy = pos.coords.accuracy;
                    const heading = pos.coords.heading;

                    if (!gpsMarker) {
                        // First fix — create blue dot + accuracy circle
                        gpsMarker = new google.maps.Marker({
                            position: loc, map: map,
                            icon: {
                                path: google.maps.SymbolPath.CIRCLE,
                                scale: 8,
                                fillColor: '#4285F4', fillOpacity: 1,
                                strokeColor: '#fff', strokeWeight: 3
                            },
                            zIndex: 2000, clickable: false,
                            title: 'My Location'
                        });
                        gpsAccuracyCircle = new google.maps.Circle({
                            map: map, center: loc,
                            radius: accuracy,
                            fillColor: '#4285F4', fillOpacity: 0.1,
                            strokeColor: '#4285F4', strokeOpacity: 0.25, strokeWeight: 1,
                            clickable: false, zIndex: 1
                        });
                        map.setCenter(loc);
                        // Check if the located region is purchased before zooming past free limit
                        var locDistrict = findDistrictAtCenter();
                        var regionPurchased = locDistrict && hasPurchase(locDistrict.productPurchaseID);
                        if (regionPurchased) {
                            if (map.getZoom() < 16) map.setZoom(17);
                        } else {
                            if (map.getZoom() < MAX_FREE_ZOOM - 1) map.setZoom(MAX_FREE_ZOOM - 1);
                        }
                        showGpsToast('Location found', '#2E7D32');
                    } else {
                        gpsMarker.setPosition(loc);
                        gpsAccuracyCircle.setCenter(loc);
                        gpsAccuracyCircle.setRadius(accuracy);
                    }

                    // Heading indicator (cone/arrow)
                    if (heading !== null && !isNaN(heading) && heading >= 0) {
                        if (!gpsHeadingMarker) {
                            gpsHeadingMarker = new google.maps.Marker({
                                position: loc, map: map,
                                icon: {
                                    path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                                    scale: 5,
                                    fillColor: '#4285F4', fillOpacity: 0.7,
                                    strokeColor: '#fff', strokeWeight: 1,
                                    rotation: heading,
                                    anchor: new google.maps.Point(0, 5)
                                },
                                zIndex: 1999, clickable: false
                            });
                        } else {
                            gpsHeadingMarker.setPosition(loc);
                            const icon = gpsHeadingMarker.getIcon();
                            icon.rotation = heading;
                            gpsHeadingMarker.setIcon(icon);
                        }
                    }

                    if (gpsFollowing) map.setCenter(loc);

                }, function(err) {
                    showGpsToast('Location access denied', '#C62828');
                    stopGpsTracking();
                }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
            }

            gpsBtn.addEventListener('click', function() {
                if (!navigator.geolocation) { updateStatus("Geolocation not supported"); return; }

                if (gpsWatchId !== null && gpsFollowing) {
                    // Following → switch to tracking only
                    gpsFollowing = false;
                    setGpsButtonState('tracking');
                    showGpsToast('Tracking location', '#1565C0');
                } else if (gpsWatchId !== null && !gpsFollowing) {
                    // Tracking → stop
                    stopGpsTracking();
                    showGpsToast('GPS tracking stopped', '#555');
                } else {
                    // Off → start following
                    startGpsTracking();
                }
            });

            // Fullscreen button
            document.getElementById('btn-fullscreen').addEventListener('click', function() {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    document.documentElement.requestFullscreen();
                }
            });
            document.addEventListener('fullscreenchange', function() {
                const icon = document.getElementById('fullscreen-icon');
                if (document.fullscreenElement) {
                    icon.innerHTML = '<polyline points="4,14 4,20 10,20"/><polyline points="20,10 20,4 14,4"/><polyline points="14,20 20,20 20,14"/><polyline points="10,4 4,4 4,10"/>';
                } else {
                    icon.innerHTML = '<polyline points="15,3 21,3 21,9"/><polyline points="9,21 3,21 3,15"/><polyline points="21,15 21,21 15,21"/><polyline points="3,9 3,3 9,3"/>';
                }
            });

            // Add-On Maps button
            document.getElementById('btn-addon-maps').addEventListener('click', function() {
                showAddonMapsPanel();
            });

            // Old Maps toggle -- switches between new DP and old DP (mutual exclusion)
            document.getElementById('btn-old-maps').addEventListener('click', function() {
                isShowingOldMaps = !isShowingOldMaps;
                this.textContent = isShowingOldMaps ? 'Load New Maps' : 'Load Old Maps';
                this.classList.toggle('active', isShowingOldMaps);

                // Clear both DP tile sets
                clearAllLayersOfType(dpOverlays);
                clearAllLayersOfType(oldDPOverlays);
                dpTileStatus = Array(dpLayerData.length).fill(false);
                oldDPTileStatus = Array(oldDPLayerData.length).fill(false);

                if (isDPLayerVisible) loadTilesBasedOnViewport();
            });

            // DP layer toggle -- controls whichever DP set is currently active
            document.getElementById('dp-layer').addEventListener('change', function() {
                isDPLayerVisible = this.checked;
                clearAllLayersOfType(dpOverlays);
                clearAllLayersOfType(oldDPOverlays);
                dpTileStatus = Array(dpLayerData.length).fill(false);
                oldDPTileStatus = Array(oldDPLayerData.length).fill(false);
                if (isDPLayerVisible) {
                    if (isShowingOldMaps) {
                        if (!oldDPDataLoaded) fetchOldDPLayerData();
                        else loadTilesBasedOnViewport();
                    } else {
                        if (!dpDataLoaded) fetchDPLayerData();
                        else loadTilesBasedOnViewport();
                    }
                }
            });

            document.getElementById('village-layer').addEventListener('change', function() {
                isVillageLayerVisible = this.checked;
                clearAllLayersOfType(villageOverlays);
                if (isVillageLayerVisible) {
                    if (!villageDataLoaded) fetchVillageLayerData();
                    else { villageTileStatus = Array(villageLayerData.length).fill(false); loadTilesBasedOnViewport(); }
                    if (villageDataByName.size === 0 && villageLayerData.length > 0) createVillageMarkers();
                    fetchVillagePurchases();
                    updateVillageMarkerVisibility();
                } else {
                    villageMarkers.forEach(function(m) { m.setMap(null); });
                    updateAddonButtonVisibility();
                }
            });

            document.getElementById('village-boundary-layer').addEventListener('change', function() {
                isVillageBoundaryEnabled = this.checked;
                if (isVillageBoundaryEnabled) {
                    loadGeoJsonForViewport();
                    maybeLoadSolapurOverlay();
                } else {
                    _removeAllVillagePolylines();
                    solapurLabelOverlays.forEach(function(ov) { ov.setMap(null); });
                    solapurLabelOverlays = [];
                    solapurTpSchemeLines.forEach(function(pl) { pl.setMap(null); });
                    solapurTpSchemeLines = [];
                    solapurOverlayLoadStarted = false;
                    solapurOverlayLoaded = false;
                }
            });

            // Sync opacity sliders (layer panel + info strip)
            const opacityPanel = document.getElementById('opacity-slider');
            const opacityInfo = document.getElementById('info-opacity-slider');
            const opacityValue = document.getElementById('opacity-value');
            const opacityLabel = document.getElementById('opacity-strip-label');

            function applyOpacity(value) {
                currentOpacity = value / 100;
                opacityValue.textContent = value + '%';
                opacityLabel.textContent = value + '%';
                opacityPanel.value = value;
                opacityInfo.value = value;
                updateOverlayOpacity(dpOverlays, currentOpacity);
                updateOverlayOpacity(villageOverlays, currentOpacity);
                updateOverlayOpacity(oldDPOverlays, currentOpacity);
            }
            opacityPanel.addEventListener('input', function() { applyOpacity(this.value); });
            opacityInfo.addEventListener('input', function() { applyOpacity(this.value); });

            // Copy coordinates on click
            document.getElementById('center-coord').addEventListener('click', function() {
                if (navigator.clipboard && this.textContent !== '--') {
                    navigator.clipboard.writeText(this.textContent);
                    updateStatus("Coordinates copied");
                }
            });

            // ===== Compass (mobile only) =====
            (function setupCompass() {
                var btn = document.getElementById('btn-compass');
                if (!btn) return;
                var overlay = document.getElementById('compass-overlay');
                var closeBtn = document.getElementById('compass-close');
                var dial = document.getElementById('compass-dial');
                var ball = document.getElementById('level-ball');
                var cardEl = document.getElementById('compass-card');
                var degEl = document.getElementById('compass-deg');
                var permBanner = document.getElementById('compass-perm-banner');
                var permBtn = document.getElementById('compass-perm-btn');
                var noSensorMsg = document.getElementById('compass-no-sensor');
                var listenerActive = false;

                // Generate 72 tick marks on the dial (every 5°) with three tiers:
                // cardinal (0/90/180/270) longest + thickest, major (every 30°)
                // medium, minor (every 5°) thin and dimmed. Deferred to idle so the
                // 72 SVG appends don't add to TBT on mobile — ticks aren't visible
                // until the user taps the compass button.
                (window.requestIdleCallback || function(cb) { return setTimeout(cb, 1500); })(function buildTicks() {
                    var ticksGroup = document.getElementById('compass-ticks');
                    if (!ticksGroup || ticksGroup.childNodes.length > 0) return;
                    var svgNs = 'http://www.w3.org/2000/svg';
                    for (var deg = 0; deg < 360; deg += 5) {
                        var isCardinal = (deg % 90 === 0);
                        var isMajor = (deg % 30 === 0);
                        var y2, sw, color, op;
                        if (isCardinal) { y2 = 24; sw = 2; color = '#E4ECF2'; op = 1; }
                        else if (isMajor) { y2 = 22; sw = 1.2; color = '#B0BEC5'; op = 0.95; }
                        else { y2 = 16; sw = 0.6; color = '#5B6E7F'; op = 0.7; }
                        var line = document.createElementNS(svgNs, 'line');
                        line.setAttribute('x1', '100');
                        line.setAttribute('y1', '10');
                        line.setAttribute('x2', '100');
                        line.setAttribute('y2', String(y2));
                        line.setAttribute('stroke', color);
                        line.setAttribute('stroke-width', String(sw));
                        line.setAttribute('opacity', String(op));
                        line.setAttribute('transform', 'rotate(' + deg + ' 100 100)');
                        ticksGroup.appendChild(line);
                    }
                });

                // Smoothing pipeline (two stages):
                // 1. Event-time: circular mean of the last N raw samples to kill spikes
                //    and high-frequency jitter before they reach the filter.
                // 2. rAF loop: dead-zone + exponential tween for the "slowly follow" feel.
                var BUF_SIZE = 4;
                var headingBuf = [];
                var gammaBuf = [];
                var betaBuf = [];
                var rawHeading = null, smoothHeading = null;
                var rawGamma = 0, rawBeta = 0, smoothGamma = 0, smoothBeta = 0;
                var rafId = 0;
                var lastDisplayedDeg = -1;
                var lastDisplayedCard = '';

                function circularMean(buf) {
                    var sx = 0, sy = 0;
                    for (var i = 0; i < buf.length; i++) {
                        var r = buf[i] * Math.PI / 180;
                        sx += Math.cos(r); sy += Math.sin(r);
                    }
                    return (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
                }
                function linearMean(buf) {
                    if (!buf.length) return 0;
                    var s = 0;
                    for (var i = 0; i < buf.length; i++) s += buf[i];
                    return s / buf.length;
                }

                function cardinalFrom(h) {
                    var cards = ['N','NE','E','SE','S','SW','W','NW','N'];
                    return cards[Math.round(h / 45) % 8];
                }

                // Heading noise floor — sub-this-degree jitter is treated as stationary.
                // Dial also "slowly follows" (small lerp) so the UI lags behind the phone
                // and catches up smoothly instead of tracking every sample.
                var HEADING_DEAD_ZONE = 1.0;  // degrees
                var TILT_DEAD_ZONE = 0.6;
                var HEADING_LERP = 0.08;
                var TILT_LERP = 0.12;

                function animate() {
                    rafId = 0;
                    if (rawHeading === null) return;
                    if (smoothHeading === null) smoothHeading = rawHeading;

                    // Shortest angular distance between smoothed and raw
                    var diffH = ((rawHeading - smoothHeading + 540) % 360) - 180;
                    var diffG = rawGamma - smoothGamma;
                    var diffB = rawBeta - smoothBeta;

                    // Dead-zone: don't move if the raw sample is within noise range.
                    var applyH = (Math.abs(diffH) < HEADING_DEAD_ZONE) ? 0 : diffH;
                    var applyG = (Math.abs(diffG) < TILT_DEAD_ZONE) ? 0 : diffG;
                    var applyB = (Math.abs(diffB) < TILT_DEAD_ZONE) ? 0 : diffB;

                    smoothHeading = (smoothHeading + applyH * HEADING_LERP + 360) % 360;
                    smoothGamma = smoothGamma + applyG * TILT_LERP;
                    smoothBeta = smoothBeta + applyB * TILT_LERP;

                    // Paint — only if anything actually moved this frame.
                    if (applyH !== 0) {
                        dial.setAttribute('transform', 'rotate(' + (-smoothHeading).toFixed(2) + ' 100 100)');
                    }
                    if (applyG !== 0 || applyB !== 0) {
                        var bx = Math.max(-20, Math.min(20, smoothGamma)) / 20 * 22;
                        var by = Math.max(-20, Math.min(20, smoothBeta)) / 20 * 22;
                        ball.setAttribute('cx', (100 + bx).toFixed(2));
                        ball.setAttribute('cy', (100 + by).toFixed(2));
                    }

                    // Text — only when rounded degree actually changes
                    var deg = Math.round(smoothHeading);
                    if (deg !== lastDisplayedDeg) {
                        lastDisplayedDeg = deg;
                        degEl.textContent = deg + '°';
                        var card = cardinalFrom(smoothHeading);
                        if (card !== lastDisplayedCard) {
                            lastDisplayedCard = card;
                            cardEl.textContent = card;
                        }
                    }

                    // Settle once everything is inside its dead zone — no more frames until
                    // a new sensor event nudges us outside it.
                    var settled = Math.abs(diffH) < HEADING_DEAD_ZONE
                        && Math.abs(diffG) < TILT_DEAD_ZONE
                        && Math.abs(diffB) < TILT_DEAD_ZONE;
                    if (listenerActive && !settled) {
                        rafId = requestAnimationFrame(animate);
                    }
                }

                function onOrient(e) {
                    // Only trust true-north absolute readings. On Android we were
                    // listening to both 'deviceorientationabsolute' (absolute) and
                    // 'deviceorientation' (often relative) — mixing them poisoned
                    // the buffer and produced wrong headings plus extra flicker.
                    var heading = null;
                    var isAbsolute = (e.type === 'deviceorientationabsolute') || (e.absolute === true);
                    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
                        heading = e.webkitCompassHeading; // iOS: already CW from true north
                    } else if (isAbsolute && e.alpha !== null && e.alpha !== undefined) {
                        // Android absolute: alpha is CCW from magnetic north.
                        // Subtract screen orientation so landscape mode stays correct.
                        var screenAngle = 0;
                        if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
                            screenAngle = window.screen.orientation.angle;
                        } else if (typeof window.orientation === 'number') {
                            screenAngle = window.orientation;
                        }
                        heading = (360 - e.alpha - screenAngle + 720) % 360;
                    }
                    if (heading === null) return; // reject non-absolute events

                    headingBuf.push(heading);
                    if (headingBuf.length > BUF_SIZE) headingBuf.shift();
                    rawHeading = circularMean(headingBuf);

                    if (typeof e.gamma === 'number') {
                        gammaBuf.push(e.gamma);
                        if (gammaBuf.length > BUF_SIZE) gammaBuf.shift();
                        rawGamma = linearMean(gammaBuf);
                    }
                    if (typeof e.beta === 'number') {
                        betaBuf.push(e.beta);
                        if (betaBuf.length > BUF_SIZE) betaBuf.shift();
                        rawBeta = linearMean(betaBuf);
                    }
                    if (rafId === 0) rafId = requestAnimationFrame(animate);
                }

                function startListening() {
                    if (listenerActive) return;
                    rawHeading = null; smoothHeading = null;
                    rawGamma = 0; rawBeta = 0;
                    smoothGamma = 0; smoothBeta = 0;
                    headingBuf = []; gammaBuf = []; betaBuf = [];
                    lastDisplayedDeg = -1; lastDisplayedCard = '';
                    window.addEventListener('deviceorientationabsolute', onOrient, true);
                    window.addEventListener('deviceorientation', onOrient, true);
                    listenerActive = true;
                }
                function stopListening() {
                    window.removeEventListener('deviceorientationabsolute', onOrient, true);
                    window.removeEventListener('deviceorientation', onOrient, true);
                    listenerActive = false;
                    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
                }

                function requestIosPerm() {
                    DeviceOrientationEvent.requestPermission().then(function(resp) {
                        if (resp === 'granted') {
                            permBanner.style.display = 'none';
                            startListening();
                        } else {
                            cardEl.textContent = '—';
                            degEl.textContent = 'denied';
                        }
                    }).catch(function() {
                        noSensorMsg.style.display = 'block';
                    });
                }

                // Force the compass overlay into fullscreen + portrait so the user can't
                // rotate the phone mid-use. The rotated-screen heading math is too
                // device-dependent to fix reliably; locking sidesteps the issue.
                // Both APIs are best-effort: if a browser refuses fullscreen or the
                // orientation lock, we silently fall back to "compass works in whatever
                // orientation the user holds the phone".
                function lockCompassToPortrait() {
                    var fsReq = overlay.requestFullscreen
                        || overlay.webkitRequestFullscreen
                        || overlay.mozRequestFullScreen
                        || overlay.msRequestFullscreen;
                    if (!fsReq) {
                        // No fullscreen support — try the lock standalone (works on installed PWAs)
                        if (window.screen && screen.orientation && screen.orientation.lock) {
                            try { screen.orientation.lock('portrait').catch(function() {}); }
                            catch (e) { /* sync throw on unsupported, ignore */ }
                        }
                        return;
                    }
                    try {
                        Promise.resolve(fsReq.call(overlay)).then(function() {
                            if (window.screen && screen.orientation && screen.orientation.lock) {
                                return screen.orientation.lock('portrait');
                            }
                        }).catch(function() { /* fullscreen denied or lock unsupported — no-op */ });
                    } catch (e) { /* ignore */ }
                }

                function unlockCompassOrientation() {
                    if (window.screen && screen.orientation && screen.orientation.unlock) {
                        try { screen.orientation.unlock(); } catch (e) {}
                    }
                    var inFs = document.fullscreenElement
                        || document.webkitFullscreenElement
                        || document.mozFullScreenElement
                        || document.msFullscreenElement;
                    if (!inFs) return;
                    var fsExit = document.exitFullscreen
                        || document.webkitExitFullscreen
                        || document.mozCancelFullScreen
                        || document.msExitFullscreen;
                    if (fsExit) {
                        try {
                            var p = fsExit.call(document);
                            if (p && p.catch) p.catch(function() {});
                        } catch (e) {}
                    }
                }

                btn.addEventListener('click', function() {
                    overlay.classList.add('open');
                    permBanner.style.display = 'none';
                    noSensorMsg.style.display = 'none';
                    // Lock to portrait synchronously inside the user-gesture handler.
                    // Must run before any await/then chain so the gesture is still active.
                    lockCompassToPortrait();
                    if (typeof DeviceOrientationEvent === 'undefined') {
                        noSensorMsg.style.display = 'block';
                        return;
                    }
                    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                        // iOS 13+: needs user-gesture-triggered permission request
                        permBanner.style.display = 'block';
                    } else {
                        startListening();
                    }
                });
                permBtn.addEventListener('click', requestIosPerm);
                closeBtn.addEventListener('click', function() {
                    overlay.classList.remove('open');
                    stopListening();
                    unlockCompassOrientation();
                });
                // Back button on mobile exits fullscreen first (browser default),
                // leaving compass open. Auto-close compass when fullscreen exits.
                document.addEventListener('fullscreenchange', function() {
                    if (!document.fullscreenElement && !document.webkitFullscreenElement && overlay.classList.contains('open')) {
                        overlay.classList.remove('open');
                        stopListening();
                    }
                });
            })();

            // ===== Measurement event listeners =====
            document.getElementById('btn-measure-length').addEventListener('click', function() {
                if (measureMode === 'length') { stopMeasureMode(false); return; }
                startMeasureMode('length');
            });
            document.getElementById('btn-measure-area').addEventListener('click', function() {
                if (measureMode === 'area') { stopMeasureMode(false); return; }
                startMeasureMode('area');
            });
            document.getElementById('measure-undo').addEventListener('click', function() {
                if (measurePoints.length === 0) return;
                measurePoints.pop();
                const last = measureMarkers.pop();
                if (last) last.setMap(null);
                updateMeasureVisuals();
            });
            document.getElementById('measure-done').addEventListener('click', function() {
                const minPts = measureMode === 'area' ? 3 : 2;
                if (measurePoints.length < minPts) return;
                stopMeasureMode(true);
            });
            document.getElementById('measure-cancel').addEventListener('click', function() {
                stopMeasureMode(false);
            });
            var _clearMeasureType = null;
            var _clearDialog = document.getElementById('clear-measure-dialog-overlay');
            var _clearText = document.getElementById('clear-measure-dialog-text');
            document.getElementById('clear-area-x').addEventListener('click', function(e) {
                e.stopPropagation();
                _clearMeasureType = 'area';
                _clearText.textContent = 'Clear all area measurements?';
                _clearDialog.classList.add('open');
            });
            document.getElementById('clear-length-x').addEventListener('click', function(e) {
                e.stopPropagation();
                _clearMeasureType = 'length';
                _clearText.textContent = 'Clear all length measurements?';
                _clearDialog.classList.add('open');
            });
            document.getElementById('clear-measure-confirm').addEventListener('click', function() {
                if (_clearMeasureType) clearMeasurementsByType(_clearMeasureType);
                _clearMeasureType = null;
                _clearDialog.classList.remove('open');
            });
            document.getElementById('clear-measure-cancel').addEventListener('click', function() {
                _clearMeasureType = null;
                _clearDialog.classList.remove('open');
            });
            document.getElementById('measure-unit-length').addEventListener('change', function() {
                if (measureMode === 'length') updateMeasureVisuals();
            });
            document.getElementById('measure-unit-area').addEventListener('change', function() {
                if (measureMode === 'area') updateMeasureVisuals();
            });

            // Deselect saved measurement / hide vertex handle when clicking empty map
            map.addListener('click', function() {
                if (activeVertexHandle && !measureMode) {
                    hideVertexHandle();
                }
                if (selectedMeasureId !== null && !measureMode) {
                    deselectMeasurement();
                }
                if (markers.length > 0 && !measureMode) {
                    markers.forEach(m => m.setMap(null));
                    markers.length = 0;
                }
            });
        }

        function clearAllLayersOfType(overlayMap) {
            if (!map) { overlayMap.clear(); return; }
            const allOverlays = map.overlayMapTypes.getArray();
            const overlaysToRemove = [];

            overlayMap.forEach((overlay, key) => {
                if (overlay) {
                    overlaysToRemove.push(overlay);
                    for (const [cacheKey, cachedOverlay] of tileCache) {
                        if (cachedOverlay === overlay) { tileCache.delete(cacheKey); break; }
                    }
                }
            });

            for (let i = allOverlays.length - 1; i >= 0; i--) {
                if (overlaysToRemove.includes(allOverlays[i])) {
                    map.overlayMapTypes.removeAt(i);
                }
            }

            overlayMap.clear();
        }

        function updateOverlayOpacity(overlayMap, opacity) {
            overlayMap.forEach((overlay) => {
                if (overlay) overlay.setOpacity(opacity);
            });
        }

        const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

        function getCachedData(cacheKey) {
            try {
                const cached = localStorage.getItem(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (Date.now() - parsed.timestamp < CACHE_TTL) return parsed.data;
                }
            } catch (e) { /* ignore corrupt cache */ }
            return null;
        }

        function setCachedData(cacheKey, data) {
            try {
                localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
            } catch (e) { /* localStorage full or unavailable */ }
        }

        function fetchLayerData() {
            if (layerDataFetched) return;
            layerDataFetched = true;
            if (isDPLayerVisible) fetchDPLayerData();
            // Always fetch old DP to check availability (shows button if data exists)
            fetchOldDPLayerData();
            // Load oldDPPlanGIS region list to check button visibility
            loadOldDPGISRegions();
            // Village metadata is ~576 KB and only used at zoom >= MIN_ZOOM_FOR_VILLAGEMAP
            // (11). Defer to browser idle so the base map can paint and DP tiles can
            // start downloading first. maybeRerunZoomCheck() inside fetchVillageLayerData
            // re-fires zoom_changed when data lands, so a cold-reload at a high zoom
            // still unlocks correctly.
            var deferVillage = function() {
                if (isVillageLayerVisible && !villageDataLoaded) fetchVillageLayerData();
            };
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(deferVillage, { timeout: 2000 });
            } else {
                setTimeout(deferVillage, 500);
            }
        }

        function applyLayerData(data, label, shouldMerge) {
            const processed = processLayerData(data);
            // PERF (maps10 fix #5): the productPurchaseID merge only applies
            // to DP/oldDP layers. Villages have their own productPurchaseIDs
            // but each village entry is independent and the marker/addon code
            // depends on per-entry villageName/latLng fields the merge clears.
            const result = shouldMerge ? _mergeByProductPurchaseID(processed) : processed;
            // Phase 1: register a Flatbush spatial index in _layerIndexMeta
            // so per-pan / per-tile viewport queries skip the linear scan
            // over all entries. Also registers a sub-sheet index per merged
            // entry in _subIndexMeta (consumed by CanvasMapType.getTile).
            // Safe no-op if Flatbush failed to load.
            _buildLayerIndex(result);
            return result;
        }

        // --- Layer-registry cache with live version-stamp listener ---
        // Attaches .on('value') to appConfig/dataVersions on first call and keeps
        // the listener alive for the session. First callback resolves the ready
        // promise. Subsequent callbacks diff incoming vs previous versions — for
        // each key that changed, the matching registered fetcher is re-run, which
        // clears its localStorage cache entry and re-pulls fresh data, updating
        // the map in place without a page reload.
        let _currentDataVersions = null;
        let _dataVersionsReady = null;
        const _layerFetchers = {}; // versionKey -> { cacheKey, refetch }
        const _inFlightLayerFetches = {}; // cacheKey -> Promise (dedupe racing callers)

        function loadDataVersions() {
            if (_dataVersionsReady) return _dataVersionsReady;
            _dataVersionsReady = new Promise(resolve => {
                let firstCallback = true;
                database.ref('appConfig/dataVersions').on('value', snap => {
                    const incoming = snap.val() || {};
                    const prev = _currentDataVersions || {};
                    _currentDataVersions = incoming;
                    if (firstCallback) {
                        firstCallback = false;
                        resolve(incoming);
                        return;
                    }
                    const allKeys = new Set([...Object.keys(prev), ...Object.keys(incoming)]);
                    allKeys.forEach(k => {
                        if (prev[k] !== incoming[k] && _layerFetchers[k]) {
                            try { localStorage.removeItem(_layerFetchers[k].cacheKey); } catch (e) {}
                            _layerFetchers[k].refetch();
                        }
                    });
                }, err => {
                    console.warn('dataVersions listener failed:', err);
                    if (firstCallback) { firstCallback = false; _currentDataVersions = {}; resolve({}); }
                });
            });
            return _dataVersionsReady;
        }

        // Returns a Promise<data>. Uses localStorage cache if its version matches the
        // live version under appConfig/dataVersions/{versionKey}. If the version node
        // doesn't exist yet (both undefined), that still counts as a match — data is
        // cached indefinitely until the admin bumps the version in Firebase console
        // (which the live listener above will detect and auto-refetch) or hits the
        // manual Refresh button.
        function getCachedOrFetchLayer(cacheKey, dbPath, versionKey, refetch) {
            if (refetch) _layerFetchers[versionKey] = { cacheKey: cacheKey, refetch: refetch };

            // Synchronous cache read — return stale data instantly, verify in background.
            let cached = null;
            try {
                const raw = localStorage.getItem(cacheKey);
                if (raw) cached = JSON.parse(raw);
            } catch (e) { /* ignore corrupt cache */ }

            if (cached && cached.d) {
                loadDataVersions().then(versions => {
                    const liveVersion = versions[versionKey];
                    const normLive = liveVersion === undefined ? null : liveVersion;
                    const normCached = cached.v === undefined ? null : cached.v;
                    if (normLive !== normCached) {
                        try { localStorage.removeItem(cacheKey); } catch (e) {}
                        if (refetch) refetch();
                    }
                }).catch(() => { /* offline: keep stale data, don't refetch */ });
                return Promise.resolve(cached.d);
            }

            if (_inFlightLayerFetches[cacheKey]) {
                return _inFlightLayerFetches[cacheKey];
            }

            const p = loadDataVersions().then(versions => {
                const liveVersion = versions[versionKey];
                const vParam = encodeURIComponent(liveVersion == null ? '0' : String(liveVersion));
                const baseUrl = LAYER_JSON_BASE + '/' + dbPath + '.bin';
                const gzUrl = baseUrl + '.gz?v=' + vParam;
                const plainUrl = baseUrl + '?v=' + vParam;
                // Prefer the gzipped twin (~2.6x smaller cold payload — JSON
                // with polygon coords gzips to ~38%) and gunzip via
                // DecompressionStream. On any failure (no support, 404 on the
                // .gz twin, decode error) fall back to the canonical .bin —
                // keeps old browsers and partial-publish states working.
                const fetchPlain = () => fetch(plainUrl, { cache: 'no-store' })
                    .then(r => {
                        if (!r.ok) throw new Error('layer fetch ' + dbPath + ' -> ' + r.status);
                        return r.json();
                    });
                const canGunzip = typeof DecompressionStream !== 'undefined';
                const fetchData = canGunzip
                    ? fetch(gzUrl, { cache: 'no-store' })
                        .then(r => {
                            if (!r.ok) throw new Error('gz ' + r.status);
                            if (!r.body) throw new Error('gz no-body');
                            return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json();
                        })
                        .catch(err => {
                            console.warn('[layer] gz fallback for', dbPath, err && err.message);
                            return fetchPlain();
                        })
                    : fetchPlain();
                return fetchData
                    .then(data => {
                        if (data) {
                            try {
                                localStorage.setItem(cacheKey, JSON.stringify({
                                    v: liveVersion === undefined ? null : liveVersion,
                                    d: data
                                }));
                            } catch (e) { /* quota */ }
                        }
                        return data;
                    });
            })
            .catch(err => {
                console.error('[layer] fetch failed for', dbPath, err);
                return null;
            })
            .then(result => {
                delete _inFlightLayerFetches[cacheKey];
                return result;
            });
            _inFlightLayerFetches[cacheKey] = p;
            return p;
        }

        function fetchDPLayerData() {
            getCachedOrFetchLayer('layer_dp', DP_URL_DATABASE_NAME, 'layer_dp', fetchDPLayerData).then(data => {
                if (!data) { dpDataLoaded = true; return; }
                dpLayerData = applyLayerData(data, "Development Plan", true);
                dpTileStatus = Array(dpLayerData.length).fill(false);
                stickyTile = null;
                stickyDistrict = null;
                dpDataLoaded = true;
                loadTilesBasedOnViewport();
                // If village markers were created before DP data arrived, isInsideDPRegion
                // returned false for every village and markers leaked into DP regions.
                // Re-create now that dpLayerData is populated so the filter applies.
                if (isVillageLayerVisible && villageLayerData.length > 0) {
                    createVillageMarkers();
                }
                maybeRerunZoomCheck();
            }).catch(error => console.error("Error fetching DP data:", error));
        }

        function fetchVillageLayerData() {
            getCachedOrFetchLayer('layer_village', VILLAGE_URL_DATABASE_NAME, 'layer_village', fetchVillageLayerData).then(data => {
                if (!data) { villageDataLoaded = true; return; }
                villageLayerData = applyLayerData(data, "Village Plan");
                villageTileStatus = Array(villageLayerData.length).fill(false);
                villageDataLoaded = true;
                loadTilesBasedOnViewport();
                if (isVillageLayerVisible && villageMarkers.size === 0) createVillageMarkers();
                maybeRerunZoomCheck();
            }).catch(error => console.error("Error fetching Village data:", error));
        }

        // After a layer fetcher completes, if both DP and village data are now
        // loaded AND the user is already at a premium zoom from a restored
        // position, re-dispatch zoom_changed so the listener can correctly
        // decide whether to show the access dialog or unlock tiles.
        function maybeRerunZoomCheck() {
            if (!dpDataLoaded || !villageDataLoaded) return;
            if (!map) return;
            try {
                if (map.getZoom() >= MAX_FREE_ZOOM) {
                    google.maps.event.trigger(map, 'zoom_changed');
                }
            } catch (e) { /* ignore */ }
        }

        // Show "Load Old Maps" only when crosshair is inside an oldDPPlanGIS polygon
        let oldDPGISPolygons = []; // parsed polygons from oldDPPlanGIS
        let oldDPGISLoaded = false;

        function loadOldDPGISRegions() {
            getCachedOrFetchLayer('layer_olddp', OLD_DP_URL_DATABASE_NAME, 'layer_olddp', fetchOldDPLayerData)
                .then(data => {
                    data = data || {};
                    for (const key in data) {
                        const item = data[key];
                        if (item && item.kml) {
                            try {
                                const polygon = parseKML(item.kml);
                                if (polygon) oldDPGISPolygons.push(polygon);
                            } catch (e) { /* skip bad entries */ }
                        }
                    }
                    oldDPGISLoaded = true;
                    updateOldMapsButtonVisibility();
                })
                .catch(err => { console.error('loadOldDPGISRegions', err); oldDPGISLoaded = true; });
        }

        function updateOldMapsButtonVisibility() {
            const btn = document.getElementById('btn-old-maps');
            if (!oldDPGISLoaded || oldDPGISPolygons.length === 0) {
                btn.style.display = 'none';
                return;
            }
            if (!map) return;
            const c = map.getCenter();
            const center = { lat: c.lat(), lng: c.lng() };
            const hasOldDP = oldDPGISPolygons.some(polygon => pointInPolygon(center, polygon.outer));
            btn.style.display = hasOldDP ? '' : 'none';
        }

        function fetchOldDPLayerData() {
            function onOldDPReady() {
                if (oldDPLayerData.length === 0) return;
                oldDPDataAvailable = true;
                updateOldMapsButtonVisibility();
                if (isShowingOldMaps && isDPLayerVisible) loadTilesBasedOnViewport();
            }

            getCachedOrFetchLayer('layer_olddp', OLD_DP_URL_DATABASE_NAME, 'layer_olddp', fetchOldDPLayerData).then(data => {
                if (!data) {
                    oldDPDataLoaded = true;
                    localStorage.removeItem('layer_olddp');
                    oldDPLayerData = [];
                    updateOldMapsButtonVisibility();
                    return;
                }
                oldDPLayerData = applyLayerData(data, "Old Development Plan", true);
                oldDPTileStatus = Array(oldDPLayerData.length).fill(false);
                oldDPDataLoaded = true;
                onOldDPReady();
            }).catch(error => console.error("Error fetching Old DP data:", error));
        }

        function computeBBox(polygon) {
            if (!polygon || polygon.length === 0) return null;
            let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
            for (const v of polygon) {
                if (v.lat < minLat) minLat = v.lat;
                if (v.lat > maxLat) maxLat = v.lat;
                if (v.lng < minLng) minLng = v.lng;
                if (v.lng > maxLng) maxLng = v.lng;
            }
            return { minLat, maxLat, minLng, maxLng };
        }

        // --- Village marker helpers ---
        function calculatePolygonCenter(polygon) {
            if (!polygon || polygon.length === 0) return null;
            let latSum = 0, lngSum = 0;
            for (const v of polygon) { latSum += v.lat; lngSum += v.lng; }
            return { lat: latSum / polygon.length, lng: lngSum / polygon.length };
        }

        function getVillageCenter(layerItem) {
            if (layerItem.latLng) {
                const parts = layerItem.latLng.split(',');
                if (parts.length >= 2) {
                    const lat = parseFloat(parts[0].trim());
                    const lng = parseFloat(parts[1].trim());
                    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
                }
            }
            return calculatePolygonCenter(layerItem.polygon);
        }

        // Check if a point is inside any DP plan polygon
        function isInsideDPRegion(center) {
            if (!dpLayerData || dpLayerData.length === 0) return false;
            var pt = { lat: center.lat, lng: center.lng };
            // PERF (maps10 fix #6): use _checkLayerEntryAtPoint so merged
            // entries walk their actual sub-sheet polygons instead of the
            // 4-corner union rectangle. Without this, every village near a
            // merged DP region (e.g. Pune) gets a false-positive "inside DP"
            // and createVillageMarkers skips it — so no marker shows up.
            // Phase 1: candidate list is index-narrowed when available.
            var cands = _candidateIndicesAtPoint(dpLayerData, pt);
            for (var i = 0; i < cands.length; i++) {
                if (_checkLayerEntryAtPoint(dpLayerData[cands[i]], pt).inside) return true;
            }
            return false;
        }

        // Find the DP region's productPurchaseID for a village (spatial lookup like Android)
        function getDPProductIdForVillage(villageItem) {
            var center = getVillageCenter(villageItem);
            if (!center) return null;
            var pt = { lat: center.lat, lng: center.lng };

            // Check current DP polygons (merged-entry safe via _checkLayerEntryAtPoint)
            // Phase 1: candidate list is index-narrowed when available.
            if (dpLayerData && dpLayerData.length > 0) {
                var dpCands = _candidateIndicesAtPoint(dpLayerData, pt);
                for (var i = 0; i < dpCands.length; i++) {
                    var dp = dpLayerData[dpCands[i]];
                    if (_checkLayerEntryAtPoint(dp, pt).inside) {
                        return dp.productPurchaseID || null;
                    }
                }
            }

            // Check old DP polygons (like Android's oldDPPolygonArraylist)
            if (typeof oldDPLayerData !== 'undefined' && oldDPLayerData && oldDPLayerData.length > 0) {
                var oldCands = _candidateIndicesAtPoint(oldDPLayerData, pt);
                for (var j = 0; j < oldCands.length; j++) {
                    var od = oldDPLayerData[oldCands[j]];
                    if (_checkLayerEntryAtPoint(od, pt).inside) {
                        return od.productPurchaseID || null;
                    }
                }
            }

            // Fallback: if village is known to be inside a DP region (from isInsideDPRegion check
            // used for marker visibility), try matching via menuGIS data
            if (villageItem.productPurchaseID) {
                // Check if any menuGIS district name partially matches the productPurchaseID
                for (var k = 0; k < menuData.length; k++) {
                    if (!menuData[k].productPurchaseID) continue;
                    var menuPid = menuData[k].productPurchaseID.toLowerCase().replace(/gst$/, '');
                    var villagePid = villageItem.productPurchaseID.toLowerCase().replace(/gst$/, '');
                    if (menuPid === villagePid || menuPid === 'district' + villagePid || 'district' + menuPid === villagePid) {
                        return menuData[k].productPurchaseID;
                    }
                }
            }

            // Last resort: if isInsideDPRegion says yes but we can't find the product ID,
            // return a truthy placeholder so the base plan dialog still shows
            if (isInsideDPRegion(pt)) {
                return '__dp_region_unknown__';
            }

            return null;
        }

        function getVillageMarkerIcon(villageName, isPurchased) {
            var bgColor = isPurchased ? '%234CAF50' : '%23FFFFFF';
            var borderColor = isPurchased ? '%232E7D32' : '%23999999';
            var textColor = isPurchased ? '%23FFFFFF' : '%23333333';
            var subColor = isPurchased ? '%23C8E6C9' : '%23999999';
            var displayName = villageName.length > 20 ? villageName.substring(0, 20) + '...' : villageName;

            // Sub text: time remaining (matches settings-bar format) or "Click to purchase"
            var subText = '';
            if (isPurchased) {
                var entry = villagePurchases.get(villageName);
                if (entry) {
                    subText = calcDaysLeft(entry.expiry) + ' left';
                }
            } else {
                subText = 'Click to purchase';
            }

            var charWidth = 6.5;
            var padding = 16;
            var nameWidth = Math.ceil(displayName.length * charWidth + padding * 2);
            var subWidth = Math.ceil(subText.length * 5.5 + padding * 2);
            var width = Math.max(nameWidth, subWidth, 50);
            var height = 40;
            var arrowH = 8;
            var totalH = height + arrowH;
            var rx = 12;
            var cx = width / 2;

            var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + totalH + '">' +
                '<rect x="1" y="1" width="' + (width - 2) + '" height="' + (height - 2) + '" rx="' + rx + '" ' +
                'fill="' + bgColor + '" stroke="' + borderColor + '" stroke-width="1.5"/>' +
                '<polygon points="' + (cx - 5) + ',' + (height - 1) + ' ' + (cx + 5) + ',' + (height - 1) + ' ' + cx + ',' + totalH + '" ' +
                'fill="' + bgColor + '" stroke="' + borderColor + '" stroke-width="1.5" stroke-linejoin="round"/>' +
                '<line x1="' + (cx - 4) + '" y1="' + (height - 1) + '" x2="' + (cx + 4) + '" y2="' + (height - 1) + '" stroke="' + bgColor + '" stroke-width="2"/>' +
                '<text x="' + cx + '" y="16" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="' + textColor + '">' +
                displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text>' +
                '<text x="' + cx + '" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="' + subColor + '">' +
                subText + '</text></svg>';

            return {
                url: 'data:image/svg+xml;charset=UTF-8,' + svg,
                scaledSize: new google.maps.Size(width, totalH),
                anchor: new google.maps.Point(cx, totalH)
            };
        }

        function hasVillagePurchase(villageName) {
            const entry = villagePurchases.get(villageName);
            return entry && entry.expiry > Date.now();
        }

        async function fetchVillagePurchases() {
            if (!currentUser || currentUser.isAnonymous || !currentUser.email) return;
            try {
                const emailKey = currentUser.email.replace(/\./g, ',');
                const snap = await firebase.database()
                    .ref('GISWebVillagePurchases/' + emailKey)
                    .once('value');
                const data = snap.val() || {};
                villagePurchases.clear();
                Object.entries(data).forEach(function(entry) {
                    var vName = entry[0], raw = entry[1];
                    var expiry = typeof raw === 'number' ? raw : (raw && raw.expiry ? raw.expiry : 0);
                    if (expiry > Date.now()) {
                        villagePurchases.set(vName, { expiry: expiry, plan: raw.plan || 'village_plan' });
                    }
                });
                updateVillageMarkerStyles();
            } catch (e) {
                console.error('Failed to fetch village purchases:', e);
            }
        }

        function createVillageMarkers() {
            // Clear existing markers
            villageMarkers.forEach(function(marker) { marker.setMap(null); });
            villageMarkers.clear();
            populateVillageDataLookup();

            // Create markers ONLY for villages outside DP plan regions
            villageLayerData.forEach(function(item) {
                if (!item.villageName) return;
                var center = getVillageCenter(item);
                if (!center) return;
                // Skip villages inside DP regions — those are accessed via addon panel
                if (isInsideDPRegion(center)) return;

                var isPurchased = hasVillagePurchase(item.villageName);
                var marker = new google.maps.Marker({
                    position: center,
                    map: null, // controlled by updateVillageMarkerVisibility
                    title: item.villageName,
                    icon: getVillageMarkerIcon(item.villageName, isPurchased),
                    zIndex: 1000
                });
                marker.addListener('click', (function(villageItem) {
                    return function() { onVillageMarkerClick(villageItem); };
                })(item));
                villageMarkers.set(item.villageName, marker);
            });

            updateVillageMarkerVisibility();
        }

        function getVillagesInView() {
            if (!map || !isVillageLayerVisible || villageLayerData.length === 0) return [];
            var zoom = map.getZoom();
            if (zoom < MIN_ZOOM_FOR_VILLAGE_MARKERS) return [];
            var bounds = map.getBounds();
            if (!bounds) return [];
            // PERF (perf #11): bbox prefilter on cached numeric centers. No
            // google.maps.LatLng allocation, no bounds.contains call, no
            // getVillageCenter polygon walk. ~50–100x faster on Pune at z13.
            var ne = bounds.getNorthEast();
            var sw = bounds.getSouthWest();
            var minLat = sw.lat(), maxLat = ne.lat();
            var minLng = sw.lng(), maxLng = ne.lng();
            var result = [];
            for (var i = 0; i < villageLayerData.length; i++) {
                var item = villageLayerData[i];
                if (!item.villageName) continue;
                var lat = item._centerLat;
                var lng = item._centerLng;
                if (lat == null || lng == null) continue;
                if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
                result.push(item);
            }
            return result;
        }

        function updateAddonButtonVisibility() {
            var btn = document.getElementById('btn-addon-maps');
            if (!btn) return;
            var inView = getVillagesInView();
            if (inView.length > 0) {
                btn.textContent = inView.length + ' Add-On Maps';
                btn.style.display = '';
            } else {
                btn.style.display = 'none';
            }
        }

        // Smooth zoom — steps one level at a time for animated effect
        function smoothZoomTo(targetZoom) {
            if (!map) return;
            var current = map.getZoom();
            if (current === targetZoom) return;
            var step = targetZoom > current ? 1 : -1;
            var listener = google.maps.event.addListener(map, 'idle', function() {
                var z = map.getZoom();
                if ((step > 0 && z >= targetZoom) || (step < 0 && z <= targetZoom)) {
                    google.maps.event.removeListener(listener);
                    return;
                }
                map.setZoom(z + step);
            });
            map.setZoom(current + step);
        }

        function zoomToVillage(villageItem) {
            var center = getVillageCenter(villageItem);
            if (!center) return;
            zoomBypassActive = true;
            map.panTo(center);
            smoothZoomTo(17);
            google.maps.event.addListenerOnce(map, 'idle', function() { zoomBypassActive = false; });
        }

        function showAddonMapsPanel() {
            var overlay = document.getElementById('addon-panel-overlay');
            var titleEl = document.getElementById('addon-panel-title');
            var listEl = document.getElementById('addon-panel-list');
            var searchEl = document.getElementById('addon-panel-search');

            var inView = getVillagesInView();
            var inViewNames = new Set(inView.map(function(v) { return v.villageName; }));
            // All villages with names for search
            var allVillages = villageLayerData.filter(function(v) { return !!v.villageName; });
            titleEl.textContent = inView.length + ' Add-On Maps in view';
            searchEl.value = '';

            function renderList(query) {
                listEl.innerHTML = '';
                var source, isSearching = false;
                if (query) {
                    // When searching, search ALL villages
                    isSearching = true;
                    var q = query.toLowerCase();
                    source = allVillages.filter(function(v) { return v.villageName.toLowerCase().indexOf(q) >= 0; });
                } else {
                    // No search — show only in-view villages
                    source = inView;
                }
                var filtered = source;
                // Sort: purchased first, then alphabetical
                filtered.sort(function(a, b) {
                    var ap = hasVillagePurchase(a.villageName) ? 0 : 1;
                    var bp = hasVillagePurchase(b.villageName) ? 0 : 1;
                    if (ap !== bp) return ap - bp;
                    return a.villageName.localeCompare(b.villageName);
                });

                if (filtered.length === 0) {
                    listEl.innerHTML = '<div style="padding:24px;text-align:center;color:#999;font-size:13px;">No villages found</div>';
                    return;
                }

                filtered.forEach(function(item) {
                    var isPurchased = hasVillagePurchase(item.villageName);
                    var itemDPPid = getDPProductIdForVillage(item);
                    var hasDPPass = itemDPPid ? hasPurchase(itemDPPid) : true; // true if not in any DP region
                    var badge = '';
                    if (isPurchased) {
                        var entry = villagePurchases.get(item.villageName);
                        var daysLeft = Math.ceil((entry.expiry - Date.now()) / (24 * 60 * 60 * 1000));
                        badge = '<span style="font-size:11px;background:#E8F5E9;color:#2E7D32;padding:2px 8px;border-radius:10px;font-weight:600;">Purchased \u2014 ' + daysLeft + 'd</span>';
                    } else if (!hasDPPass) {
                        badge = '<span style="font-size:11px;background:#FFF3E0;color:#E65100;padding:2px 8px;border-radius:10px;font-weight:600;">Region Required</span>';
                    } else {
                        badge = '<span style="font-size:11px;background:#E3F2FD;color:#1565C0;padding:2px 8px;border-radius:10px;font-weight:600;cursor:pointer;">Purchase</span>';
                    }

                    var inViewChip = '';
                    if (isSearching && inViewNames.has(item.villageName)) {
                        inViewChip = '<span style="font-size:9px;background:#E8F5E9;color:#2E7D32;padding:1px 5px;border-radius:6px;margin-right:6px;">In View</span>';
                    }

                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px;cursor:pointer;border-bottom:1px solid #f0f0f0;';
                    row.innerHTML = '<span style="font-size:13px;font-weight:500;color:#333;flex:1;margin-right:8px;">' +
                        item.villageName.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>' + inViewChip + badge;

                    row.addEventListener('mouseenter', function() { this.style.background = '#f5f5f5'; });
                    row.addEventListener('mouseleave', function() { this.style.background = ''; });

                    row.addEventListener('click', (function(villageItem) {
                        return function() {
                            overlay.classList.remove('open');
                            // Delay so the back-button history cleanup from addon panel
                            // close completes before the next dialog opens
                            setTimeout(function() {
                                onVillageMarkerClick(villageItem);
                            }, 300);
                        };
                    })(item));

                    listEl.appendChild(row);
                });
            }

            renderList('');

            // Wire search
            searchEl.oninput = function() { renderList(this.value.trim()); };

            // Close handler
            document.getElementById('addon-panel-close').onclick = function() {
                overlay.classList.remove('open');
            };

            overlay.classList.add('open');
        }

        var MIN_ZOOM_FOR_VILLAGE_MARKERS = 13;

        // Populate villageDataByName without creating map markers
        // Villages are browsed/purchased only via the Add-On Maps panel
        function populateVillageDataLookup() {
            villageDataByName.clear();
            villageLayerData.forEach(function(item) {
                if (item.villageName) villageDataByName.set(item.villageName, item);
            });
            updateAddonButtonVisibility();
        }

        // PERF (perf #11): track which markers are currently attached to the
        // map so updateVillageMarkerVisibility can skip the no-op setMap
        // calls. Pans within the same visible-village set become near-free.
        var _currentlyVisibleVillageMarkers = new Set();

        function updateVillageMarkerVisibility() {
            var zoom = map ? map.getZoom() : 0;
            var shouldShow = isVillageLayerVisible && zoom >= MIN_ZOOM_FOR_VILLAGE_MARKERS;

            if (!shouldShow) {
                // Hide whatever's currently shown
                if (_currentlyVisibleVillageMarkers.size > 0) {
                    _currentlyVisibleVillageMarkers.forEach(function(name) {
                        var m = villageMarkers.get(name);
                        if (m) m.setMap(null);
                    });
                    _currentlyVisibleVillageMarkers.clear();
                }
                updateAddonButtonVisibility();
                return;
            }

            // Compute the new visible set via the same bbox prefilter as
            // getVillagesInView. Uses the cached numeric centers populated by
            // processLayerData — no LatLng allocations, no getVillageCenter calls.
            var bounds = map.getBounds();
            if (!bounds) return;
            var ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
            var minLat = sw.lat(), maxLat = ne.lat();
            var minLng = sw.lng(), maxLng = ne.lng();

            var newVisible = new Set();
            villageMarkers.forEach(function(marker, name) {
                var item = villageDataByName.get(name);
                if (!item) return;
                var lat = item._centerLat;
                var lng = item._centerLng;
                if (lat == null || lng == null) return;
                if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) return;
                newVisible.add(name);
            });

            // Diff: only setMap for markers that actually changed visibility
            _currentlyVisibleVillageMarkers.forEach(function(name) {
                if (!newVisible.has(name)) {
                    var m = villageMarkers.get(name);
                    if (m) m.setMap(null);
                }
            });
            newVisible.forEach(function(name) {
                if (!_currentlyVisibleVillageMarkers.has(name)) {
                    var m = villageMarkers.get(name);
                    if (m) m.setMap(map);
                }
            });
            _currentlyVisibleVillageMarkers = newVisible;

            updateAddonButtonVisibility();
        }

        function updateVillageMarkerStyles() {
            villageMarkers.forEach(function(marker, villageName) {
                var isPurchased = hasVillagePurchase(villageName);
                marker.setIcon(getVillageMarkerIcon(villageName, isPurchased));
            });
        }

        function onVillageMarkerClick(villageItem) {
            var villageName = villageItem.villageName;

            if (hasVillagePurchase(villageName)) {
                // Already purchased — zoom to village at 17
                zoomToVillage(villageItem);
                updateStatus(villageName + ' — purchased');
                return;
            }

            // Check if DP region is purchased first (spatial lookup)
            var dpProductId = getDPProductIdForVillage(villageItem);
            if (dpProductId && !hasPurchase(dpProductId)) {
                // Don't zoom — just show the base plan dialog
                // Zooming would trigger the zoom_changed paywall simultaneously
                pendingVillageAfterDP = villageItem;
                var district = findDistrictByPurchaseId(dpProductId);
                // Fallback: try findDistrictAtCenter for the name
                if (!district) district = findDistrictAtCenter();
                var regionName = district ? district.districtName : 'this region';
                var districtObj = district || { productPurchaseID: dpProductId, districtName: regionName };
                showBasePlanRequiredDialog(villageItem.villageName, regionName, districtObj);
                return;
            }

            // DP is purchased (or no DP) — move to village and show purchase dialog
            var center = getVillageCenter(villageItem);
            if (center) {
                zoomBypassActive = true;
                map.panTo(center);
                if (map.getZoom() < 15) smoothZoomTo(15);
                google.maps.event.addListenerOnce(map, 'idle', function() { zoomBypassActive = false; });
            }
            showVillagePurchaseDialog(villageItem);
        }

        function showBasePlanRequiredDialog(villageName, regionName, districtObj) {
            var overlay = document.getElementById('baseplan-required-overlay');
            document.getElementById('baseplan-title').textContent = 'Subscribe to ' + regionName;
            document.getElementById('baseplan-desc').textContent = 'The village plan add-on for ' + villageName + ' requires the ' + regionName + ' Development Plan base plan to be purchased first.';

            // Replace button to clear old listeners
            var subscribeBtn = document.getElementById('baseplan-subscribe-btn');
            var newBtn = subscribeBtn.cloneNode(true);
            newBtn.id = 'baseplan-subscribe-btn';
            newBtn.textContent = 'Subscribe to ' + regionName;
            subscribeBtn.parentNode.replaceChild(newBtn, subscribeBtn);

            newBtn.addEventListener('click', function() {
                overlay.classList.remove('open');
                // Delay so the back-button history cleanup from baseplan dialog
                // close completes before the zoom-restrict dialog opens
                setTimeout(function() {
                    showZoomRestrictionDialog(districtObj);
                }, 300);
            });

            document.getElementById('baseplan-cancel-btn').onclick = function() {
                overlay.classList.remove('open');
                pendingVillageAfterDP = null;
                // Also dismiss any zoom-restrict dialog that might be underneath
                document.getElementById('zoom-restrict-overlay').classList.remove('open');
                enableMapInteraction();
            };

            overlay.classList.add('open');
        }

        function showVillagePurchaseDialog(villageItem) {
            var overlay = document.getElementById('village-purchase-overlay');
            var title = document.getElementById('village-purchase-title');
            var desc = document.getElementById('village-purchase-desc');
            var priceEl = document.getElementById('village-price-amount');
            var actionBtn = document.getElementById('village-purchase-action');

            title.textContent = villageItem.villageName;
            desc.textContent = 'Unlock the village plan map for ' + villageItem.villageName + '. Full access for 7 days.';

            // Get village plan price from pre-fetched pricing cache
            var price = cachedPricing.get('villagePlanDefault') || cachedPricing.get('default') || null;
            if (price) {
                priceEl.textContent = '\u20B9' + price;
            } else {
                priceEl.textContent = 'Loading...';
                var priceCheck = setInterval(function() {
                    var p = cachedPricing.get('villagePlanDefault') || cachedPricing.get('default');
                    if (p) { priceEl.textContent = '\u20B9' + p; clearInterval(priceCheck); }
                }, 500);
                setTimeout(function() { clearInterval(priceCheck); }, 10000);
            }

            // Replace button to clear old listeners
            var newBtn = actionBtn.cloneNode(true);
            newBtn.id = 'village-purchase-action';
            actionBtn.parentNode.replaceChild(newBtn, actionBtn);

            newBtn.addEventListener('click', function() {
                overlay.classList.remove('open');
                setTimeout(function() {
                    buyVillage(villageItem.villageName);
                }, 300);
            });

            document.getElementById('village-purchase-cancel').onclick = function() {
                overlay.classList.remove('open');
            };

            document.getElementById('village-support-btn').onclick = function() {
                overlay.classList.remove('open');
                openSupportForm(null, false);
            };

            overlay.classList.add('open');

            // Cycle app hints (Android / Microsoft Store) — alternate start each time
            var villageAppScroll = document.getElementById('village-app-hints-scroll');
            var villageAppDots = document.getElementById('village-app-hint-dots');
            if (villageAppScroll) {
                var vDotEls = villageAppDots ? villageAppDots.querySelectorAll('.pd-app-hint-dot') : [];
                var villageAppCycleTimer = null;
                function updateVillageDots() {
                    if (!vDotEls.length) return;
                    var idx = villageAppScroll.scrollLeft > villageAppScroll.scrollWidth / 4 ? 1 : 0;
                    vDotEls.forEach(function(d, i) {
                        d.classList.toggle('pd-app-hint-dot-active', i === idx);
                    });
                }
                function stopVillageCycle() {
                    if (villageAppCycleTimer) { clearInterval(villageAppCycleTimer); villageAppCycleTimer = null; }
                }
                var lastApp = sessionStorage.getItem('village-app-last') || 'android';
                if (lastApp === 'android') {
                    villageAppScroll.scrollLeft = villageAppScroll.scrollWidth - villageAppScroll.clientWidth;
                    sessionStorage.setItem('village-app-last', 'windows');
                } else {
                    villageAppScroll.scrollLeft = 0;
                    sessionStorage.setItem('village-app-last', 'android');
                }
                updateVillageDots();
                villageAppCycleTimer = setInterval(function() {
                    if (!overlay.classList.contains('open')) { stopVillageCycle(); return; }
                    villageAppScroll.scrollTo({ left: villageAppScroll.scrollLeft > 0 ? 0 : villageAppScroll.scrollWidth, behavior: 'smooth' });
                }, 2000);
                villageAppScroll.addEventListener('touchstart', stopVillageCycle, { once: true });
                villageAppScroll.addEventListener('scroll', updateVillageDots, { passive: true });
                vDotEls.forEach(function(d, i) {
                    d.addEventListener('click', function() {
                        stopVillageCycle();
                        villageAppScroll.scrollTo({ left: i === 0 ? 0 : villageAppScroll.scrollWidth, behavior: 'smooth' });
                    });
                });
            }
        }

        async function buyVillage(villageName) {
            if (!currentUser || currentUser.isAnonymous) {
                pendingPurchase = { villageName: villageName, purchaseType: 'village' };
                document.getElementById('auth-dialog-desc').textContent =
                    'Sign in with your Google account to purchase the village plan for ' + villageName + '.';
                document.getElementById('auth-dialog-weblabel').style.display = 'block';
                document.getElementById('auth-dialog-overlay').classList.add('open');
                return;
            }

            // Silent-unlock if already active — post-login resume over an
            // already-purchased village should show the toast, not re-prompt payment.
            if (hasVillagePurchase(villageName)) {
                showUnlockToast(villageName);
                updateVillageMarkerStyles();
                var vItem = villageDataByName.get(villageName);
                if (vItem) zoomToVillage(vItem);
                return;
            }

            var loadingOverlay = document.getElementById('payment-loading-overlay');
            document.getElementById('payment-loading-sub').textContent = 'Village Plan: ' + villageName;
            loadingOverlay.classList.add('open');

            try {
                var createOrder = functions.httpsCallable('createOrder');
                var result = await createOrder({
                    productId: 'villagePlanDefault',
                    regionName: villageName,
                    purchaseType: 'village',
                    villageName: villageName
                });
                var data = result.data;

                loadingOverlay.classList.remove('open');

                var options = {
                    key: 'rzp_live_SXr1BKnoysSo9r',
                    order_id: data.orderId,
                    amount: data.amount,
                    currency: data.currency || 'INR',
                    name: 'Village Plan (GIS)',
                    description: 'Web only (not Android) — 7-Day Pass: ' + villageName,
                    prefill: { email: currentUser.email, name: currentUser.displayName || '' },
                    theme: { color: '#1565C0' },
                    handler: async function(response) {
                        updateStatus('Payment successful! Activating...');
                        try {
                            var confirmPayment = functions.httpsCallable('confirmPayment');
                            await confirmPayment({
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_order_id: response.razorpay_order_id,
                                razorpay_signature: response.razorpay_signature,
                                productId: 'villagePlanDefault',
                                regionName: villageName,
                                purchaseType: 'village',
                                villageName: villageName
                            });
                            try {
                                mmAnalytics.event('purchase', {
                                    transaction_id: response.razorpay_payment_id,
                                    value: (data.amount || 0) / 100,
                                    currency: data.currency || 'INR',
                                    items: [{ item_id: 'villagePlanDefault', item_name: villageName, item_category: 'village' }]
                                });
                                mmAnalytics.clarityTag('plan', 'paid');
                            } catch (e) {}
                            await fetchVillagePurchases();
                            // Reload village tiles
                            clearAllLayersOfType(villageOverlays);
                            villageTileStatus = Array(villageLayerData.length).fill(false);
                            loadTilesBasedOnViewport();
                            updateAddonButtonVisibility();
                            // Zoom to the purchased village at level 17
                            var vItem = villageDataByName.get(villageName);
                            if (vItem) zoomToVillage(vItem);
                            updateStatus('Village plan activated for ' + villageName + '!');
                        } catch (e) {
                            console.error('Confirm payment error:', e);
                            setTimeout(function() { fetchVillagePurchases(); }, 3000);
                        }
                    },
                    modal: {
                        ondismiss: function() { updateStatus('Payment cancelled'); }
                    }
                };

                if (typeof Razorpay === 'undefined') {
                    await new Promise(function(resolve, reject) {
                        var s = document.createElement('script');
                        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
                        s.onload = resolve;
                        s.onerror = function() { reject(new Error('Could not load payment gateway.')); };
                        document.head.appendChild(s);
                    });
                }
                try {
                    mmAnalytics.event('begin_checkout', {
                        currency: data.currency || 'INR',
                        value: (data.amount || 0) / 100,
                        items: [{ item_id: 'villagePlanDefault', item_name: villageName, item_category: 'village' }]
                    });
                } catch (e) {}
                var rzp = new Razorpay(options);
                try {
                    rzp.on('payment.failed', function(resp) {
                        var err = (resp && resp.error) || {};
                        mmAnalytics.event('payment_failed', {
                            item_id: 'villagePlanDefault',
                            item_category: 'village',
                            code: String(err.code || '').slice(0, 60),
                            reason: String(err.reason || err.description || '').slice(0, 120)
                        });
                    });
                } catch (e) {}
                rzp.open();
            } catch (error) {
                loadingOverlay.classList.remove('open');
                var ecode = (error && error.code) || '';
                if (ecode === 'already-exists' || ecode === 'functions/already-exists') {
                    await fetchVillagePurchases();
                    updateVillageMarkerStyles();
                    showUnlockToast(villageName);
                } else {
                    alert('Payment error: ' + (error.message || JSON.stringify(error)));
                    updateStatus('Payment failed');
                }
            }
        }

        function processLayerData(data) {
            const result = [];

            for (const key in data) {
                if (data.hasOwnProperty(key)) {
                    const item = data[key];

                    if (item && item.kml && item.link) {
                        try {
                            const parsed = parseKML(item.kml);
                            const polygon = parsed ? parsed.outer : null;
                            const holes = parsed ? parsed.holes : [];

                            const entry = {
                                id: key,
                                link: item.link,
                                kml: item.kml,
                                polygon: polygon,
                                holes: holes,
                                bbox: computeBBox(polygon),
                                minZoom: parseInt(item.MinZoom || item.minZoom) || 0,
                                maxZoom: parseInt(item.MaxZoom || item.maxZoom) || 22,
                                zIndex: parseFloat(item.ZIndex || item.zIndex) || 0,
                                productPurchaseID: item.productPurchaseID || '',
                                villageName: item.VillageName || '',
                                latLng: item.LatitudeAndLongitude || ''
                            };

                            // PERF (perf #11): pre-compute the village center as
                            // plain numbers so getVillagesInView and
                            // updateVillageMarkerVisibility can do a 4-comparison
                            // bbox prefilter on every pan instead of allocating
                            // a google.maps.LatLng + calling bounds.contains per
                            // village. Only meaningful for village entries
                            // (DP/oldDP have empty villageName).
                            if (entry.villageName) {
                                const c = getVillageCenter(entry);
                                if (c) {
                                    entry._centerLat = c.lat;
                                    entry._centerLng = c.lng;
                                }
                            }

                            result.push(entry);
                        } catch (error) {
                            console.warn(`Error processing data item ${key}:`, error);
                        }
                    }
                }
            }

            // PERF (maps10): productPurchaseID merge moved into applyLayerData
            // and gated by a shouldMerge flag — DP/oldDP get merged, villages
            // do NOT (the village marker/addon code depends on per-entry
            // villageName/latLng fields the merge clears). See maps10 fix #5.
            return result;
        }

        function _mergeByProductPurchaseID(entries) {
            // 1. Count entries per productPurchaseID
            const counts = new Map();
            for (let i = 0; i < entries.length; i++) {
                const pid = entries[i].productPurchaseID;
                if (!pid) continue;
                counts.set(pid, (counts.get(pid) || 0) + 1);
            }

            // 2. Collect entries that need merging (any pid with count > 1)
            const groups = new Map();
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                const pid = e.productPurchaseID;
                if (!pid || counts.get(pid) === 1) continue;
                if (!groups.has(pid)) groups.set(pid, []);
                groups.get(pid).push(e);
            }

            if (groups.size === 0) return entries;  // nothing to merge

            // 3. Build one merged virtual entry per group
            const mergedByPid = new Map();
            groups.forEach(function(group, pid) {
                let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity;
                let minZ = Infinity, maxZ = -Infinity;
                let zIdxMax = -Infinity;
                const subSheets = [];
                for (let i = 0; i < group.length; i++) {
                    const sub = group[i];
                    if (sub.bbox) {
                        if (sub.bbox.maxLat > n) n = sub.bbox.maxLat;
                        if (sub.bbox.minLat < s) s = sub.bbox.minLat;
                        if (sub.bbox.maxLng > e) e = sub.bbox.maxLng;
                        if (sub.bbox.minLng < w) w = sub.bbox.minLng;
                    }
                    if (typeof sub.minZoom === 'number' && sub.minZoom < minZ) minZ = sub.minZoom;
                    if (typeof sub.maxZoom === 'number' && sub.maxZoom > maxZ) maxZ = sub.maxZoom;
                    if (typeof sub.zIndex === 'number' && sub.zIndex > zIdxMax) zIdxMax = sub.zIndex;
                    subSheets.push({
                        id: sub.id,
                        link: sub.link,
                        polygon: sub.polygon,
                        holes: sub.holes || [],
                        bbox: sub.bbox,
                        minZoom: sub.minZoom,
                        maxZoom: sub.maxZoom,
                        zIndex: sub.zIndex
                    });
                }
                const mergedBbox = { minLat: s, maxLat: n, minLng: w, maxLng: e };
                // Polygon = bbox rectangle (4 corners). Rough but sufficient for
                // worker visibility tests + findDistrictAtCenter; per-tile
                // accuracy is enforced inside CanvasMapType.getTile.
                const mergedPolygon = [
                    { lat: s, lng: w },
                    { lat: n, lng: w },
                    { lat: n, lng: e },
                    { lat: s, lng: e }
                ];
                mergedByPid.set(pid, {
                    id: 'merged_' + pid,
                    link: '',
                    kml: '',
                    polygon: mergedPolygon,
                    bbox: mergedBbox,
                    minZoom: minZ === Infinity ? 0 : minZ,
                    maxZoom: maxZ === -Infinity ? 22 : maxZ,
                    zIndex: zIdxMax === -Infinity ? 0 : zIdxMax,
                    productPurchaseID: pid,
                    villageName: '',
                    latLng: '',
                    isMerged: true,
                    subSheets: subSheets
                });
            });

            // 4. Walk the original array, emit ungrouped entries as-is and
            //    emit each merged entry once at the position of its first
            //    sub-sheet so layering order is roughly preserved.
            const out = [];
            const emittedPids = new Set();
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                const pid = e.productPurchaseID;
                if (!pid || counts.get(pid) === 1) {
                    out.push(e);
                    continue;
                }
                if (emittedPids.has(pid)) continue;
                emittedPids.add(pid);
                out.push(mergedByPid.get(pid));
            }
            return out;
        }

        // Phase 1 spatial index — Flatbush bbox tree per layer array so that
        // isInsideDPRegion / getDPProductIdForVillage / findDistrictAtCenter
        // and the tile-visibility worker can stop linear-scanning 100–500
        // entries on every pan. Each merged entry also gets a sub-sheet
        // Flatbush consumed by CanvasMapType.getTile. Coordinates: x = lng,
        // y = lat.
        //
        // Side-channel via WeakMap (NOT expando properties on the arrays /
        // entries): the layer array is shipped to the tile worker via
        // postMessage, which structured-clones it. Flatbush instances hold
        // non-cloneable typed-array constructor refs (Float64Array etc.), so
        // attaching them as expando properties triggers DataCloneError.
        // WeakMap keeps them main-thread-only.
        const _layerIndexMeta = new WeakMap();  // layer array -> { index, indexBuffer, idxMap }
        const _subIndexMeta = new WeakMap();    // merged entry -> { index, idxMap }

        function _buildLayerIndex(entries) {
            if (!entries || entries.length === 0) return entries;
            if (typeof Flatbush === 'undefined') return entries;

            let nIndexable = 0;
            for (let i = 0; i < entries.length; i++) {
                if (entries[i] && entries[i].bbox) nIndexable++;
            }
            if (nIndexable === 0) return entries;

            const fb = new Flatbush(nIndexable);
            const idxMap = new Int32Array(nIndexable);
            let j = 0;
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                const b = e && e.bbox;
                if (!b) continue;
                fb.add(b.minLng, b.minLat, b.maxLng, b.maxLat);
                idxMap[j++] = i;

                // Sub-sheet index for merged entries.
                if (e.isMerged && Array.isArray(e.subSheets) && e.subSheets.length > 0) {
                    const subs = e.subSheets;
                    let nSub = 0;
                    for (let k = 0; k < subs.length; k++) if (subs[k] && subs[k].bbox) nSub++;
                    if (nSub > 0) {
                        const sfb = new Flatbush(nSub);
                        const subMap = new Int32Array(nSub);
                        let m = 0;
                        for (let k = 0; k < subs.length; k++) {
                            const sb = subs[k] && subs[k].bbox;
                            if (!sb) continue;
                            sfb.add(sb.minLng, sb.minLat, sb.maxLng, sb.maxLat);
                            subMap[m++] = k;
                        }
                        sfb.finish();
                        _subIndexMeta.set(e, { index: sfb, idxMap: subMap });
                    }
                }
            }
            fb.finish();
            _layerIndexMeta.set(entries, { index: fb, indexBuffer: fb.data, idxMap: idxMap });
            return entries;
        }

        function parseKML(kml) {
            if (!kml) return null;

            try {
                // KML format: "lng,lat,0 lng,lat,0 ... close lng,lat,0 ..."
                // The `close` keyword marks the end of one ring and the start
                // of the next. The first ring is the outer boundary; every
                // subsequent ring is a hole inside the outer (donut/polygon-
                // with-holes semantic). E.g. Solapur NonCongested = whole DP
                // outer + close + central congested area (drawn as a hole).
                const coordinates = kml.trim().split(" ");
                const rings = [];
                let current = [];

                for (const coord of coordinates) {
                    if (coord.includes("close")) {
                        if (current.length > 0) { rings.push(current); current = []; }
                        continue;
                    }
                    const parts = coord.replace(',0', '').split(',');
                    if (parts.length >= 2) {
                        try {
                            const lng = parseFloat(parts[0]);
                            const lat = parseFloat(parts[1]);
                            if (!isNaN(lat) && !isNaN(lng)) current.push({ lat, lng });
                        } catch (e) {
                            console.warn("Error parsing coordinate:", coord, e);
                        }
                    }
                }
                if (current.length > 0) rings.push(current);

                if (rings.length === 0 || rings[0].length <= 2) return null;
                return { outer: rings[0], holes: rings.slice(1).filter(r => r.length > 2) };
            } catch (error) {
                console.error("Error parsing KML:", error);
                return null;
            }
        }

        function loadTilesBasedOnViewport() {
            if (!map) return;
            if (!cfCookiesReady) return; // Don't request tile images before cookies are set
            const currentBounds = map.getBounds();
            if (!currentBounds) return;

            // Increment generation -- any in-flight worker results from older generations will be discarded
            currentGeneration++;

            const currentZoom = map.getZoom();

            // PERF (maps9): cancel every tile fetch that's not at the current
            // zoom across all DP/village/oldDP overlays. Stops bandwidth + decode
            // races between stale-zoom and new-zoom requests when the user
            // zooms 11 -> 12 -> 13 in quick succession.
            if (currentZoom !== _mmLastSeenZoom) {
                _mmLastSeenZoom = currentZoom;
                _mmCancelStaleZoomTiles(currentZoom);
            }
            const center = map.getCenter();
            const centerPoint = { lat: center.lat(), lng: center.lng() };
            const vp = {
                minLat: currentBounds.getSouthWest().lat(),
                maxLat: currentBounds.getNorthEast().lat(),
                minLng: currentBounds.getSouthWest().lng(),
                maxLng: currentBounds.getNorthEast().lng()
            };

            // Build list of visible layers to send to worker. The full polygon
            // data is cached inside the worker (see `layerCache` above) and only
            // resent when the main-thread array reference changes, e.g. after a
            // cache-version refetch. This keeps the per-pan message tiny.
            //
            // Zoom-gate: if the current zoom is outside a layer's range, skip
            // it entirely — no clone, no worker work, and existing overlays stay
            // put (they honor their own zMin_/zMax_ so no tiles render anyway).
            const activeTypes = [];
            const zl = ZOOM_LIMITS;

            function considerLayer(type, data, dataLoaded, visible, limits) {
                if (!visible || !dataLoaded || !data || !data.length) return;
                if (currentZoom < limits[0] || currentZoom > limits[1]) return;
                if (_workerSentRefs[type] !== data) {
                    const msg = { kind: 'loadLayer', type: type, data: data };
                    const transfer = [];
                    // Phase 1: ship the Flatbush index alongside the data. We
                    // slice the index ArrayBuffer + copy the idxMap so the
                    // main thread's Flatbush instance keeps working after the
                    // transfer detaches the worker-side buffers. Sidecar via
                    // _layerIndexMeta (NOT array expandos) — see comment by
                    // _buildLayerIndex for why.
                    const meta = _layerIndexMeta.get(data);
                    if (meta) {
                        msg.indexBuffer = meta.indexBuffer.slice(0);
                        msg.indexIdxMap = new Int32Array(meta.idxMap).buffer;
                        transfer.push(msg.indexBuffer, msg.indexIdxMap);
                    }
                    tileWorker.postMessage(msg, transfer);
                    _workerSentRefs[type] = data;
                }
                activeTypes.push({ type: type, zoomLimits: limits });
            }

            // DP: show new OR old, never both (controlled by isShowingOldMaps toggle)
            considerLayer('dp', dpLayerData, dpDataLoaded, isDPLayerVisible && !isShowingOldMaps, zl.dp);
            considerLayer('oldDP', oldDPLayerData, oldDPDataLoaded, isDPLayerVisible && isShowingOldMaps, zl.oldDP);
            considerLayer('village', villageLayerData, villageDataLoaded, isVillageLayerVisible, zl.village);

            if (activeTypes.length === 0) return;

            // First time tiles have data ready — unblock deferred GeoJSON loading.
            // Village-boundary geojson zips are up to ~2 MB per district and parsing
            // them on the main thread competes with the first tile paint; defer to
            // browser idle so the map pixels land first.
            if (!tilesInitiated) {
                tilesInitiated = true;
                if (typeof window.requestIdleCallback === 'function') {
                    window.requestIdleCallback(function() { loadGeoJsonForViewport(); }, { timeout: 2000 });
                } else {
                    setTimeout(loadGeoJsonForViewport, 300);
                }
            }

            // Send to Web Worker -- polygon math runs in background thread
            tileWorker.postMessage({ kind: 'compute', generation: currentGeneration, activeTypes: activeTypes, currentZoom: currentZoom, centerPoint: centerPoint, vp: vp });
        }

        // Initialize a cache for tile loading
        const tileCache = new Map();

        // Custom MapType that renders tiles to <canvas> via off-DOM Image objects.
        // Why: native ImageMapType uses <img src=tile.png> which gets scraped by
        // Ctrl+S / File->Save As (browser refetches every <img src> into _files/).
        // Off-DOM Images are never in the DOM tree, so Save As can't see them;
        // canvas pixel data is runtime-only, so saved pages show blank tiles.
        // No CORS needed -- tainted canvas still displays, we just can't read pixels.
        // PERF (maps10): tile coord -> tile-center lat/lng (Web Mercator).
        // Used by CanvasMapType.getTile for merged-entry sub-sheet dispatch.
        function _tileCoordToCenterLatLng(x, y, z) {
            var n = Math.pow(2, z);
            var lng = ((x + 0.5) / n) * 360 - 180;
            var latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n)));
            return { lat: latRad * 180 / Math.PI, lng: lng };
        }

        // PERF (perf #12 v2 REVERTED): _latLngToWorldPx removed. The world-pixel
        // vertex cache caused boundaries to shift during Google Maps' zoom
        // animations because the animation appears to use a CSS transform
        // (not a pure translation) that a single-reference-point delta
        // calculation can't capture. Reverted to the un-cached projection
        // path in VillageBoundaryOverlay.draw().

        // PERF (maps10 fix): full tile bbox in lat/lng. Needed because a tile
        // can straddle a sub-sheet boundary — its CENTER might be outside a
        // sub-sheet polygon while half its pixels are still inside. We use
        // bbox intersection instead of point-in-polygon to dispatch.
        function _tileCoordToBoundsLatLng(x, y, z) {
            var n = Math.pow(2, z);
            var minLng = (x / n) * 360 - 180;
            var maxLng = ((x + 1) / n) * 360 - 180;
            var maxLatRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
            var minLatRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)));
            return {
                minLat: minLatRad * 180 / Math.PI,
                maxLat: maxLatRad * 180 / Math.PI,
                minLng: minLng,
                maxLng: maxLng
            };
        }

        function _lineSegsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
            if (Math.max(x1, x2) < Math.min(x3, x4) || Math.max(x3, x4) < Math.min(x1, x2) ||
                Math.max(y1, y2) < Math.min(y3, y4) || Math.max(y3, y4) < Math.min(y1, y2)) return false;
            var det = (x2 - x1) * (y4 - y3) - (x4 - x3) * (y2 - y1);
            if (Math.abs(det) < 1e-10) return false;
            var t = ((x3 - x1) * (y4 - y3) - (x4 - x3) * (y3 - y1)) / det;
            var u = -((x2 - x1) * (y3 - y1) - (x2 - x3) * (y2 - y1)) / det;
            return t >= 0 && t <= 1 && u >= 0 && u <= 1;
        }

        // True if the polygon covers any part of the tile bbox tb. The third
        // (edge-vs-edge) check is what the old per-tile code missed: at z>=17
        // a tile (~150m wide) is often sliced by a polygon edge between two
        // distant vertices, so center-outside + no-vertex-inside was wrongly
        // rejecting valid edge tiles, leaving sharp blank rectangles along
        // district boundaries.
        function _polygonCoversTile(poly, tb) {
            if (!poly || poly.length === 0) return false;
            var cLat = (tb.minLat + tb.maxLat) / 2;
            var cLng = (tb.minLng + tb.maxLng) / 2;
            if (pointInPolygon({ lat: cLat, lng: cLng }, poly)) return true;
            for (var i = 0; i < poly.length; i++) {
                var pv = poly[i];
                if (pv.lat >= tb.minLat && pv.lat <= tb.maxLat &&
                    pv.lng >= tb.minLng && pv.lng <= tb.maxLng) return true;
            }
            var edges = [
                [tb.minLat, tb.minLng, tb.maxLat, tb.minLng],
                [tb.maxLat, tb.minLng, tb.maxLat, tb.maxLng],
                [tb.maxLat, tb.maxLng, tb.minLat, tb.maxLng],
                [tb.minLat, tb.maxLng, tb.minLat, tb.minLng]
            ];
            for (var j = 0, k = poly.length - 1; j < poly.length; k = j++) {
                var s = poly[k], e = poly[j];
                for (var ei = 0; ei < 4; ei++) {
                    var b = edges[ei];
                    if (_lineSegsIntersect(s.lat, s.lng, e.lat, e.lng, b[0], b[1], b[2], b[3])) return true;
                }
            }
            return false;
        }

        function CanvasMapType(layerDef, layerType, opacity) {
            this.tileSize = new google.maps.Size(256, 256);
            this.maxZoom = 22;
            this.minZoom = 0;
            this.name = layerType + '_' + layerDef.id;
            this.layerDef = layerDef;
            this.layerType = layerType;
            this.opacity_ = opacity;
            this.tiles_ = new Set();
            // PERF (maps9): per-zoom tile registry so we can explicitly cancel
            // every in-flight fetch for a zoom level that's no longer current.
            // Google Maps' own releaseTile fires lazily during zoom transitions
            // and leaves orphan fetches racing the new-zoom requests.
            this._tilesByZoom = Object.create(null);

            // Resolve layer-specific zoom bounds (mirrors old ImageMapType logic).
            var def = layerDef;
            switch (layerType) {
                case "dp":      this.zMin_ = def.minZoom || MIN_ZOOM_FOR_DP;         this.zMax_ = def.maxZoom || MAX_ZOOM_FOR_DP;         break;
                case "village": this.zMin_ = def.minZoom || MIN_ZOOM_FOR_VILLAGEMAP; this.zMax_ = def.maxZoom || MAX_ZOOM_FOR_VILLAGEMAP; break;
                case "oldDP":   this.zMin_ = def.minZoom || MIN_ZOOM_FOR_OLD_DP;     this.zMax_ = def.maxZoom || MAX_ZOOM_FOR_OLD_DP;     break;
                default:        this.zMin_ = 0; this.zMax_ = 22;
            }

            // PERF (maps10): merged entries store their sub-sheet URLs +
            // polygons separately. Each tile request dispatches to the
            // matching sub-sheet via a point-in-polygon check on the tile
            // center. urlPrefix_ stays empty for merged entries.
            if (def.isMerged && def.subSheets && def.subSheets.length > 0) {
                this._merged = true;
                this._subSheets = def.subSheets.map(function(sub) {
                    var lk = sub.link || '';
                    return {
                        bbox: sub.bbox,
                        polygon: sub.polygon,
                        holes: sub.holes || [],
                        minZoom: sub.minZoom,
                        maxZoom: sub.maxZoom,
                        zIndex: (typeof sub.zIndex === 'number') ? sub.zIndex : 0,
                        urlPrefix: tileBaseUrl + (lk.endsWith('/') ? lk : lk + '/')
                    };
                });
                // Phase 1: carry over the Flatbush sub-sheet index registered
                // by _buildLayerIndex (sidecar WeakMap keyed by the merged
                // entry — see _subIndexMeta). getTile uses it to skip the
                // linear scan when the merged entry has many sub-sheets.
                // May be undefined if Flatbush didn't load or no sub-sheet
                // had a bbox — getTile falls back to the linear loop then.
                var _smeta = _subIndexMeta.get(def);
                this._subFlatbush = _smeta ? _smeta.index : null;
                this._subFlatbushIdxMap = _smeta ? _smeta.idxMap : null;
                this.urlPrefix_ = '';
            } else {
                this._merged = false;
                this._subSheets = null;
                // Build tile URL prefix once.
                var link = def.link || '';
                this.urlPrefix_ = tileBaseUrl + (link.endsWith('/') ? link : link + '/');
            }
        }

        CanvasMapType.prototype.getTile = function(tileCoord, zoom, ownerDocument) {
            var div = ownerDocument.createElement('div');
            div.style.width = '256px';
            div.style.height = '256px';
            div.style.opacity = this.opacity_;

            // Zoom out of range: return empty div (matches old getTileUrl returning null).
            if (zoom < this.zMin_ || zoom > this.zMax_) return div;

            var canvas = ownerDocument.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            canvas.style.width = '256px';
            canvas.style.height = '256px';
            canvas.style.display = 'block';
            div.appendChild(canvas);
            var ctx = canvas.getContext('2d');

            var _mmLayerType = this.layerType;
            var _mmPid = (this.layerDef && this.layerDef.productPurchaseID) || '';

            // PERF (maps10 fix #4): for merged entries, the tile may be covered
            // by MULTIPLE overlapping sub-sheets. Picking just one and 404-ing
            // the rest leaves "loading in parts" gaps in overlap zones (which
            // only resolve at very high zoom because then a tile fits inside a
            // single sub-sheet). Fix: fetch from EVERY sub-sheet whose bbox
            // overlaps the tile, and drawImage each one as it lands. PNG tiles
            // have transparent pixels where each sub-sheet doesn't have data,
            // so layering them composites correctly into a union.
            //
            // Cost: ~1-3 fetches per tile in overlap zones, ~1 fetch elsewhere.
            // Compared to the original un-merged ~50 overlays × every tile,
            // still a 10x+ improvement.
            if (this._merged) {
                var tb = _tileCoordToBoundsLatLng(tileCoord.x, tileCoord.y, zoom);
                var matches = [];
                // Phase 1: narrow the sub-sheet iteration via the Flatbush
                // index built in _buildLayerIndex. For merged entries with
                // many sub-sheets, this drops the per-tile cost from O(N) to
                // O(log N + K) where K = sub-sheets actually overlapping the
                // tile bbox. Fallback path: index missing → original linear
                // scan, identical semantics.
                var _candIdxs = null;
                if (this._subFlatbush) {
                    var _hits = this._subFlatbush.search(tb.minLng, tb.minLat, tb.maxLng, tb.maxLat);
                    var _imap = this._subFlatbushIdxMap;
                    _candIdxs = new Array(_hits.length);
                    for (var _ci = 0; _ci < _hits.length; _ci++) _candIdxs[_ci] = _imap[_hits[_ci]];
                }
                var _candN = _candIdxs ? _candIdxs.length : this._subSheets.length;
                for (var _si = 0; _si < _candN; _si++) {
                    var si = _candIdxs ? _candIdxs[_si] : _si;
                    var sub = this._subSheets[si];
                    if (typeof sub.minZoom === 'number' && zoom < sub.minZoom) continue;
                    if (typeof sub.maxZoom === 'number' && zoom > sub.maxZoom) continue;
                    var sb = sub.bbox;
                    if (!sb) continue;
                    // Bbox overlap test (rectangles intersect) — fast reject.
                    if (tb.maxLat < sb.minLat || tb.minLat > sb.maxLat ||
                        tb.maxLng < sb.minLng || tb.minLng > sb.maxLng) continue;
                    // Polygon test — bbox overlap is necessary but not sufficient
                    // when sub-sheets sit inside one another (e.g. a city-centre
                    // congested-area polygon nested inside a non-congested
                    // polygon sharing the same productPurchaseID). Without this
                    // we fetch tiles for the inner sheet across its bbox
                    // rectangle and 404 most of them. Cheap two-step test:
                    // tile centre inside polygon, or any polygon vertex inside
                    // the tile bbox.
                    var poly = sub.polygon;
                    if (poly && poly.length > 0) {
                        if (!_polygonCoversTile(poly, tb)) continue;

                        // Donut semantic: if the tile's centre sits inside any
                        // hole AND no hole vertex lies in the tile bbox, the
                        // tile is fully inside the hole and has no data — skip.
                        // (If a hole vertex IS in the tile bbox, the tile
                        // straddles the hole boundary so partial data exists.)
                        var holes = sub.holes;
                        if (holes && holes.length > 0) {
                            var cLat = (tb.minLat + tb.maxLat) / 2;
                            var cLng = (tb.minLng + tb.maxLng) / 2;
                            var inHole = false;
                            for (var hi = 0; hi < holes.length && !inHole; hi++) {
                                var hole = holes[hi];
                                if (!hole || hole.length < 3) continue;
                                if (!pointInPolygon({ lat: cLat, lng: cLng }, hole)) continue;
                                var holeVertexInTile = false;
                                for (var hvi = 0; hvi < hole.length; hvi++) {
                                    var hv = hole[hvi];
                                    if (hv.lat >= tb.minLat && hv.lat <= tb.maxLat &&
                                        hv.lng >= tb.minLng && hv.lng <= tb.maxLng) {
                                        holeVertexInTile = true;
                                        break;
                                    }
                                }
                                if (!holeVertexInTile) inHole = true;
                            }
                            if (inHole) continue;
                        }
                    }
                    matches.push(sub);
                }

                if (matches.length === 0) {
                    return div;   // no coverage, blank tile
                }

                var imgs = new Array(matches.length);
                var loadState = new Array(matches.length);
                var firedAnalytics = false;
                // Composite sub-sheets in zIndex order, NOT network load order, so
                // a higher-zIndex sheet that overlaps a lower one it sits inside
                // (e.g. KhargharRaigad z=50000 nested in PanvelDevelopmentPlan z=0)
                // stays painted on top instead of being overwritten by whichever
                // tile happens to finish loading last. Clear + redraw all loaded
                // sub-sheets on each onload — cheap at 256x256 with ~1-3 sheets.
                function repaintMerged() {
                    if (!div.parentNode) return;
                    var order = [];
                    for (var k = 0; k < matches.length; k++) {
                        var im = imgs[k];
                        if (loadState[k] && im && im.complete && im.naturalWidth > 0) order.push(k);
                    }
                    order.sort(function(a, b) {
                        var za = (typeof matches[a].zIndex === 'number') ? matches[a].zIndex : 0;
                        var zb = (typeof matches[b].zIndex === 'number') ? matches[b].zIndex : 0;
                        return za !== zb ? za - zb : a - b;
                    });
                    ctx.clearRect(0, 0, 256, 256);
                    for (var oi = 0; oi < order.length; oi++) {
                        try { ctx.drawImage(imgs[order[oi]], 0, 0, 256, 256); } catch (e) {}
                    }
                }
                for (var mi = 0; mi < matches.length; mi++) {
                    (function(sub, idx) {
                        var img = new Image();
                        img.onload = function() {
                            loadState[idx] = true;
                            repaintMerged();
                            if (!firedAnalytics && Math.random() < 0.05) {
                                firedAnalytics = true;
                                try {
                                    mmAnalytics.event('tile_loaded', {
                                        layer_type: _mmLayerType,
                                        zoom: zoom,
                                        bucket: zoom > 14 ? 'premium' : 'free',
                                        pid: _mmPid
                                    });
                                } catch (e) {}
                            }
                        };
                        img.onerror = function() {
                            /* 404/auth — sub-sheet doesn't actually cover this tile, leave that layer blank */
                        };
                        var subUrl = sub.urlPrefix + zoom + '/' + tileCoord.x + '/' + tileCoord.y + '.png';
                        loadTileWithCache(subUrl, zoom).then(function(blobUrl) {
                            if (blobUrl) {
                                var origOnload = img.onload;
                                var origOnerror = img.onerror;
                                img._mmBlobUrl = blobUrl;
                                img.onload = function() {
                                    if (origOnload) origOnload.call(img);
                                    if (img._mmBlobUrl) { try { URL.revokeObjectURL(img._mmBlobUrl); } catch (e) {} img._mmBlobUrl = null; }
                                };
                                img.onerror = function() {
                                    if (origOnerror) origOnerror.call(img);
                                    if (img._mmBlobUrl) { try { URL.revokeObjectURL(img._mmBlobUrl); } catch (e) {} img._mmBlobUrl = null; }
                                };
                                img.src = blobUrl;
                            } else {
                                img.src = subUrl;
                            }
                        }).catch(function() { img.src = subUrl; });
                        imgs[idx] = img;
                    })(matches[mi], mi);
                }
                div._tileImgs = imgs;
                div._tileZoom = zoom;
                this.tiles_.add(div);
                if (!this._tilesByZoom[zoom]) this._tilesByZoom[zoom] = new Set();
                this._tilesByZoom[zoom].add(div);
                return div;
            }

            // PERF: per-tile polygon containment for un-merged layers.
            // Mirrors the merged path above, for the case where two
            // un-merged layers nest (e.g. a small KML entirely inside a
            // larger KML with a different productPurchaseID). Without
            // this, every tile in the viewport that overlaps the
            // layer's bbox is fetched, including tiles whose 256x256
            // footprint sits entirely outside the layer's polygon.
            var _ldef = this.layerDef;
            if (_ldef && _ldef.polygon && _ldef.polygon.length > 0) {
                var tbU = _tileCoordToBoundsLatLng(tileCoord.x, tileCoord.y, zoom);
                var sbU = _ldef.bbox;
                if (sbU && (tbU.maxLat < sbU.minLat || tbU.minLat > sbU.maxLat ||
                    tbU.maxLng < sbU.minLng || tbU.minLng > sbU.maxLng)) {
                    return div;
                }
                if (!_polygonCoversTile(_ldef.polygon, tbU)) return div;

                // Donut semantic — see merged path above.
                var holesU = _ldef.holes;
                if (holesU && holesU.length > 0) {
                    var cLatU = (tbU.minLat + tbU.maxLat) / 2;
                    var cLngU = (tbU.minLng + tbU.maxLng) / 2;
                    var inHoleU = false;
                    for (var hiU = 0; hiU < holesU.length && !inHoleU; hiU++) {
                        var holeU = holesU[hiU];
                        if (!holeU || holeU.length < 3) continue;
                        if (!pointInPolygon({ lat: cLatU, lng: cLngU }, holeU)) continue;
                        var holeVertexInTileU = false;
                        for (var hvU = 0; hvU < holeU.length; hvU++) {
                            var pvHU = holeU[hvU];
                            if (pvHU.lat >= tbU.minLat && pvHU.lat <= tbU.maxLat &&
                                pvHU.lng >= tbU.minLng && pvHU.lng <= tbU.maxLng) {
                                holeVertexInTileU = true;
                                break;
                            }
                        }
                        if (!holeVertexInTileU) inHoleU = true;
                    }
                    if (inHoleU) return div;
                }
            }

            // Un-merged path: single Image fetch (unchanged from maps9).
            var img = new Image();
            img.onload = function() {
                // Tile may have been released while loading -- skip if detached.
                if (div.parentNode) ctx.drawImage(img, 0, 0, 256, 256);
                // Analytics: 5% sample of successful tile loads to cap GA4 event volume
                if (Math.random() < 0.05) {
                    try {
                        mmAnalytics.event('tile_loaded', {
                            layer_type: _mmLayerType,
                            zoom: zoom,
                            bucket: zoom > 14 ? 'premium' : 'free',
                            pid: _mmPid
                        });
                    } catch (e) {}
                }
            };
            img.onerror = function() {
                /* 404/auth -- leave tile blank */
                try {
                    mmAnalytics.event('tile_load_failure', {
                        layer_type: _mmLayerType,
                        zoom: zoom,
                        bucket: zoom > 14 ? 'premium' : 'free',
                        pid: _mmPid
                    });
                } catch (e) {}
            };
            var tileUrl = this.urlPrefix_ + zoom + '/' + tileCoord.x + '/' + tileCoord.y + '.png';
            loadTileWithCache(tileUrl, zoom).then(function(blobUrl) {
                if (blobUrl) {
                    var origOnload = img.onload;
                    var origOnerror = img.onerror;
                    img._mmBlobUrl = blobUrl;
                    img.onload = function() {
                        if (origOnload) origOnload.call(img);
                        if (img._mmBlobUrl) { try { URL.revokeObjectURL(img._mmBlobUrl); } catch (e) {} img._mmBlobUrl = null; }
                    };
                    img.onerror = function() {
                        if (origOnerror) origOnerror.call(img);
                        if (img._mmBlobUrl) { try { URL.revokeObjectURL(img._mmBlobUrl); } catch (e) {} img._mmBlobUrl = null; }
                    };
                    img.src = blobUrl;
                } else {
                    img.src = tileUrl;
                }
            }).catch(function() { img.src = tileUrl; });

            div._tileImg = img;
            div._tileZoom = zoom;
            this.tiles_.add(div);
            // Register in the per-zoom bucket so cancelTilesNotAtZoom can find it.
            if (!this._tilesByZoom[zoom]) this._tilesByZoom[zoom] = new Set();
            this._tilesByZoom[zoom].add(div);
            return div;
        };

        // Helper: cancel all in-flight Image fetches owned by a tile div.
        // Handles both single-image (un-merged) and multi-image (merged maps10) cases.
        function _abortTileImages(tile) {
            var img = tile && tile._tileImg;
            if (img) {
                if (img._mmBlobUrl) { try { URL.revokeObjectURL(img._mmBlobUrl); } catch (e) {} img._mmBlobUrl = null; }
                img.onload = null;
                img.onerror = null;
                img.src = '';
                tile._tileImg = null;
            }
            var imgs = tile && tile._tileImgs;
            if (imgs) {
                for (var i = 0; i < imgs.length; i++) {
                    var im = imgs[i];
                    if (im) {
                        if (im._mmBlobUrl) { try { URL.revokeObjectURL(im._mmBlobUrl); } catch (e) {} im._mmBlobUrl = null; }
                        im.onload = null;
                        im.onerror = null;
                        im.src = '';
                    }
                }
                tile._tileImgs = null;
            }
        }

        CanvasMapType.prototype.releaseTile = function(tile) {
            this.tiles_.delete(tile);
            // Drop from the per-zoom bucket too.
            if (tile && tile._tileZoom != null && this._tilesByZoom[tile._tileZoom]) {
                this._tilesByZoom[tile._tileZoom].delete(tile);
            }
            _abortTileImages(tile);
        };

        // PERF (maps9): on zoom change we explicitly tear down every tile
        // belonging to a zoom level that isn't the current one. Google Maps
        // calls releaseTile lazily during zoom transitions; without this,
        // dozens of stale-zoom Image fetches keep streaming bytes and racing
        // the new-zoom requests for HTTP connections + decode time.
        CanvasMapType.prototype.cancelTilesNotAtZoom = function(currentZoom) {
            for (var z in this._tilesByZoom) {
                if (parseInt(z, 10) === currentZoom) continue;
                var bucket = this._tilesByZoom[z];
                if (!bucket) continue;
                bucket.forEach(function(tile) {
                    _abortTileImages(tile);
                });
                bucket.clear();
            }
        };

        CanvasMapType.prototype.setOpacity = function(opacity) {
            this.opacity_ = opacity;
            this.tiles_.forEach(function(div) { div.style.opacity = opacity; });
        };

        function loadTileOverlay(layerDef, layerType, overlayMap) {
            try {
                const cacheKey = `${layerType}_${layerDef.id}`;
                if (tileCache.has(cacheKey)) {
                    const cachedOverlay = tileCache.get(cacheKey);

                    // Re-add cached overlay to map (browser HTTP cache avoids re-downloading tiles)
                    cachedOverlay.setOpacity(currentOpacity);
                    map.overlayMapTypes.push(cachedOverlay);
                    overlayMap.set(layerDef.id, cachedOverlay);

                    return cachedOverlay;
                }
                
                // Canvas-rendered tiles: tiles paint to <canvas> via off-DOM Image.
                // Defeats Ctrl+S / File->Save As scraping (no <img src> in DOM to harvest,
                // canvas pixels are runtime-only). Browser auto-sends signed cookies.
                const customMapType = new CanvasMapType(layerDef, layerType, currentOpacity);

                // Set the zIndex
                customMapType.zIndex = layerDef.zIndex || 0;
                
                // Add to map
                map.overlayMapTypes.push(customMapType);
                
                // Store reference
                overlayMap.set(layerDef.id, customMapType);
                
                // Add to cache
                tileCache.set(cacheKey, customMapType);
                
                return customMapType;
            } catch (error) {
                console.error(`Error creating tile overlay for ${layerType} layer ${layerDef.id}:`, error);
                return null;
            }
        }

        function unloadTileOverlay(layerId, overlayMap) {
            const overlay = overlayMap.get(layerId);
            if (!overlay) return;

            // Actually remove from map -- this cancels in-flight HTTP tile requests
            // (frees bandwidth for new tiles at the current zoom level)
            const allOverlays = map.overlayMapTypes.getArray();
            const idx = allOverlays.indexOf(overlay);
            if (idx !== -1) map.overlayMapTypes.removeAt(idx);

            // Keep in overlayMap for tracking, keep in tileCache for fast re-add
            overlayMap.delete(layerId);
        }

        function updateStatus(message) {
            const statusElement = document.getElementById('status-indicator');
            if (statusElement) {
                statusElement.textContent = message;
                clearTimeout(window.statusTimeout);
                window.statusTimeout = setTimeout(() => {
                    if (statusElement.textContent === message) {
                        statusElement.textContent = 'Ready';
                    }
                }, 2000);
            }
        }
