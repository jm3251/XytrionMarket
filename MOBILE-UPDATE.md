# Xytrion Market mobile and desktop compatibility update

This update starts from `xytrionMarket-notifications-email-fix.zip`. It keeps the existing design, Node server, MongoDB data models, Telegram administration, SMTP worker, and server-authoritative financial workflows. Testing used disposable local accounts and an isolated MongoDB replica set. Your live AWS deployment and production database were not changed.

## What was repaired

| Area | Changes |
| --- | --- |
| Navigation | The dashboard drawer, header, main content and mobile action controls use a consistent 1024px desktop breakpoint. Drawers have an explicit close button, backdrop, Escape support, focus handling and scroll locking. Sidebar width and main-content reservation now agree. |
| Phone and tablet layout | Shared responsive CSS is loaded once on all 34 HTML pages. Intrinsic-width grid children, headings, back buttons, signup CAPTCHA/trust rows, payment steps, footer links, tables and third-party embeds are constrained or reflowed. Wide tables scroll inside their container instead of widening the page. |
| Live Markets | Mobile cards show the existing live price, change and volume fields rather than hiding them. Search remains available. Invalid Alpine URL bindings were replaced with real local destinations. Existing quote source/freshness behavior is unchanged; missing quotes are not fabricated. |
| Account information | Mobile navbar balances use the same authenticated hydration selectors as desktop. Static Profile Settings labels are no longer overwritten with the user's name. Referral-copy display uses the existing account identifier. Simultaneous profile refreshes share one request. |
| Notifications and chat | The bell panel is viewport-anchored on phones/tablets with an internal scrolling list. Chat uses the available visual viewport, measured bottom bar/floating-action clearance and safe-area spacing. Its input/send/close controls remain inside short screens, and chat no longer covers transaction dialogs or the open drawer. |
| Deposits | Wallet copy and QR controls wait for a loaded wallet address. Clipboard failures receive feedback. The picker/drop paths validate PNG/JPEG/GIF files up to 10MB. Rapid repeated submissions are guarded; one proof submission produces one request. Duplicate Telegram client script includes were removed. |
| Account settings | Save Changes busy state is controlled by the actual API request and always resets. The obsolete duplicate jQuery submit handler was removed. Password-strength feedback works, password-eye controls have accessible labels, and tabs are horizontally reachable on narrow screens. The nonfunctional avatar-upload affordance was removed. |
| Dialogs and investments | Existing investment validation and server calls remain in place. Investment inputs use decimal keyboard hints and do not force the keyboard open on touch devices. SweetAlert and withdrawal dialogs fit the usable viewport and remain above chat. |
| Existing broken affordances | Mobile Refer Friends and Bots Trading links now reach their matching existing pages. Invalid placeholder JavaScript loads and unsupported Alpine transition syntax were removed. HTML pages incorrectly linked as CSS were removed. |

The original project did not implement manual BUY/SELL order execution, biometric/QR authentication, or automated password recovery. Those controls are not silently connected to imaginary services: they now explain the limitation instead of posting to `#`, failing silently, or implying a completed transaction. Legacy public quote tables that depend on a missing optional DataTables widget display a link to the supported Live Markets page rather than throwing an exception. No new brokerage execution or authentication backend was added.

## Verification

| Check | Result |
| --- | --- |
| Repository build | `npm run build` passed: lint, 37 automated tests, and project integrity checks for 34 HTML pages. |
| Page layout scan | All 34 pages were checked in Chromium at 320, 390, 768 and 1366 CSS pixels: 136 page/viewport combinations. No page-width overflow or expanded mobile layout viewport remained. |
| JavaScript errors | The final page scan and focused homepage recheck recorded no uncaught application JavaScript exceptions at the tested widths. |
| Phone/tablet/laptop navigation | All protected pages were visited with authenticated test sessions. Drawer opening/closing, sidebar reservation and session persistence were checked. |
| Operation checks | Bell popup/read action, account balance/theme, Live Markets price visibility/search, investment insufficient-balance validation, account save/password controls and withdrawal confirmation were checked at 320×568, 768×1024, 1366×900 and 568×320. |
| Targeted chat/deposit checks | All eight final checks passed across those four viewports: actual chat-send acknowledgments, usable chat controls, rejected invalid files, and one real deposit POST despite two rapid submit events. |
| Session review recheck | Eight affected session/sidebar/browser regression tests passed after request coalescing. |
| Production isolation | Server/backend source files were not changed. Real customer accounts, real Telegram messages, real SMTP deliveries and live AWS services were not used by the tests. |

These are browser-emulated tests, not a claim of testing every physical phone. Real iOS Safari/Android keyboard, clipboard permission prompts, camera/file pickers, and third-party widget availability should still receive a short device check after deployment. Some external analytics/translation or embedded-document requests were blocked in the automated harness to keep tests isolated; this does not disable them in the delivered website. Market feeds and external widgets still depend on their providers and network availability.

## Files and runtime

The new shared files are `assets/css/responsive.css`, `assets/js/responsive.js`, and `test/responsive.test.js`. Existing HTML pages reference the shared files. There are no new environment variables or production dependencies for this update. Your existing MongoDB, Telegram, SMTP, origin and session settings remain valid.

## Safe installation and AWS upgrade

Before replacing project files, privately back up your `.env` and the `uploads/` directory. Do not copy them into GitHub, chat, or this ZIP. MongoDB remains the authoritative data store; this update does not reset it.

Replace the old source files with this archive's source. Preserve your `.env`, runtime uploads, and any local production-only settings. If deploying through GitHub, commit only source files and confirm `.env` remains ignored. Push the source update, then run in your AWS SSH terminal:

```bash
cd /home/ubuntu/XytrionMarket
git pull --ff-only
npm ci --omit=dev
sudo systemctl restart xytrion
sudo systemctl status xytrion --no-pager
curl https://xytrionmarkets.com/api/health
```

The expected health response is `{"ok":true,"api":"online","database":"connected"}`. If Git reports local changes, do not force-reset or overwrite your private settings; review the changes first. `npm run build` needs development dependencies, so use `npm ci` rather than `npm ci --omit=dev` when running the build locally.

Open the site on your phone and laptop and hard-refresh once. If Cloudflare still serves older assets, purge the affected cached assets in Cloudflare. Verify login, every sidebar destination, a small test chat message, wallet network/address display, account settings, and the notification bell before using production financial operations. Actual deposit approval and withdrawal completion still require the existing authorized administration process.

## Final authentication check

The rendered registration and login forms passed on a 320px phone viewport and a 1366px laptop viewport. New signup credential fields start empty and remain editable. A late ordinary `pageshow` event now preserves values the user has typed, while a restored cached signup page clears the credential fields. This prevents a slow-loading external widget from erasing an in-progress signup. The final `npm run build` after these changes passed all 37 tests.
