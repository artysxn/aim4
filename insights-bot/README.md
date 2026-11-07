# Insights bot (standalone)

Places the real-money Polymarket orders that aim4.io's bots decide on, and claims winnings every 5 minutes.
The bots, settings and tracking stay on aim4.io (Insights > Bots). This only needs to run somewhere Polymarket allows trading.

## On the Mac

Needs Node 22 or newer (`brew install node`).

```sh
cd aim4/insights-bot
npm install
npm run setup -- ~/Downloads/insights-executor.json   # or: npm run setup, and type the values
npm start                                             # try it: wait for "talking to https://aim4.io", then Ctrl+C
npm run install-service                               # run 24/7
```

Config file: on the PC it is `C:\Users\<you>\.aim4\insights-executor.json`. Copy it to the Mac (AirDrop, USB), run setup with it, then delete the copy.
It holds the signer key: never commit it or put it in this folder.

**Then on the PC:** Insights > Settings > This PC > **Forget**, so only the Mac places orders.

## 24/7

- `install-service` starts the bot at login, restarts it if it crashes, and keeps the Mac awake while it is on the charger.
- Keep the Mac plugged in and logged in. Closing the lid sleeps it unless an external display is attached, so leave the lid open.
- Log: `tail -f ~/Library/Logs/aim4-insights-bot.log` (a status line every 5 minutes).
- Stop: `npm run uninstall-service`.
- Update: `git pull`, then `npm run install-service` again.

Check it on aim4.io: the banner shows **PC executor online** and the country (NO allowed).

## Rebuilding bot.mjs

`bot.mjs` is built from `server/insights/`. After changing the executor, from the repo root: `node insights-bot/build.mjs`.
