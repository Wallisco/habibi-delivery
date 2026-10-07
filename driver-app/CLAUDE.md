FEEST Driver app — instructions for Claude Code
Read this before every task in driver-app/. The spec is `driver-app/docs/driver-app-spec.md`; the step-by-step build prompts are `driver-app/docs/claude-code-playbook.md`.

What this is
The FEEST driver app (Habibi was the working name). React Native on Expo, one codebase published to the App Store and Google Play as "FEEST Driver". It talks only to the FEEST dispatch service in this repo (dispatch-service/, habibi-api.quikr.co.za; staging habibi-staging.quikr.co.za). It is not part of the ScootHero app or the FEEST back office.

The bar
Simple. Easy to get in, easy to get jobs, easy to go forwards and backwards. A driver on a bike, one hand, in sun, never wonders what to tap and never gets stuck.

Non-negotiables
Never stuck: every screen has a back arrow or, during a delivery, "Report a problem"; Android back is handled on every screen; the app always recovers from a job that was cancelled, closed or reassigned, and from a sign-out sent by the office.
Fits without scrolling on a 360×640 and a 390×844 phone. Only list bodies scroll; their headers and filters stay fixed.
One primary action per screen. The online/offline switch lives only in the top-right of Home, with the Open market and Long distance switches under it.
One app for every driver, FEEST and white-label brands alike: a brand job shows the brand's logo and colours, but there is never a separate app per brand. Every driver is in the open market; only the back office approves drivers for a brand.
Sizes and colours come only from src/theme.js (primary button 48pt, secondary 40pt, body 15pt, 44pt minimum tap target). No hard-coded sizes or colours in screens.
No default place names. The zone always comes from the driver's live position.
Pay is calculated by dispatch only (dispatch-service/src/fees.js). The app shows it, never recalculates it.
Location only while online or on a delivery, after the prominent disclosure screen. Positions are never stored on the phone beyond the current trip.
No personal customer data on screen beyond first name, suburb and what is needed for the drop-off; nothing personal in logs.
Plain words: "Messages", "Go online", "Report a problem". Sentence case.

Workflow
A push to main deploys the dispatch server. Work on a branch per step; merge only after it works on staging. Read the relevant code first, propose a short plan, wait for approval before large changes. Tests in __tests__ for every state change and recovery path; `npm test` green before saying a step is done. Finish with what changed, how to test it on a phone, anything left open.
