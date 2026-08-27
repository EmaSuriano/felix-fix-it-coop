# Felix Fix-It Coop

A browser remake of https://github.com/EmaSuriano/Felix-fix-it-multiplayer
Two Felixes, one building, peer-to-peer. Built on Kaplay plus Trystero using the
kaplay-coop-starter architecture.

Fix cracked and smashed windows, dodge falling bricks and flying ducks, grab the
pie (torta) for a berserker rush. Host is the source of truth; the joiner sends
position and hammer swings.

## How to play

- Move: WASD or arrow keys (grid steps on the 4x5 window facade)
- Hammer: Space or J. Repairs a damaged window (2 smashed to 1 cracked to 0 fixed)
  and awards 100 points. In berserker, a smashed window goes straight to fixed.
- Lives: start with 3. A brick or duck on your cell without immunity costs 1 life,
  then about 2s of immunity. Extra life every 2000 points (max 3).
- Pie: sometimes appears on a window. Stand on it or hammer it for about 5s of
  berserker plus immunity (faster repairs).
- Stages: most windows start damaged. When every pane is fixed, the next stage
  begins with more bricks and ducks.
- Game over: when both players are out of lives. Refresh for a new room.

Host is blue; the joiner is orange. The match waits until the second player joins.
Open the menu, Create Game, share the code or link; the other player uses Join Game.

## Local development

Use the Vite dev server (port 3000). Install packages, then start the dev
script. Open the printed localhost URL. Create Game on one tab, Join Game with the
room code on the second tab. WebRTC will not work from a file URL.

## How rooms work

There is no game server. The host generates a 6-character code and puts it in
the room query param on the share URL; joiners open that link.

The host simulates windows, hazards, scores, lives, and stage, and broadcasts a
world snapshot about 10 times a second. Both players send pos on grid moves and
hammer on swing. The joiner renders from world snapshots.

APP_ID is felix-fix-it-coop. GitHub Pages uses base path /felix-fix-it-coop/
Homepage: https://emasuriano.github.io/felix-fix-it-coop/

## Credits

Original C/SDL multiplayer:

- Emanuel Suriano (EmaSuriano)
- Esteban Barrett (Ph003)
- Federico Casabona (FedeCasabona)

Web remake uses Kaplay and Trystero MQTT.

## License

MIT
