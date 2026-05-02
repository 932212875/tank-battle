import "./styles.css";

type Direction = "up" | "down" | "left" | "right";

type RoomSummary = {
  id: string;
  hostName: string;
  count: number;
  max: number;
  status: "waiting" | "playing";
};

type RoomState = {
  id: string;
  hostId: string;
  status: "waiting" | "playing";
  players: Array<{ id: string; name: string; ready: boolean; host: boolean }>;
};

type Tank = {
  id: string;
  name: string;
  kind: "player" | "enemy";
  x: number;
  y: number;
  dir: Direction;
  lives: number;
  alive: boolean;
  shieldUntil?: number;
  shieldHits?: number;
};

type GameSnapshot = {
  width: number;
  height: number;
  tanks: Tank[];
  bullets: Array<{ id: string; ownerKind: "player" | "enemy"; x: number; y: number; dir: Direction }>;
  walls: Array<{ id: string; x: number; y: number; hp: number }>;
  bushes: Array<{ id: string; x: number; y: number; size: number }>;
  base: { x: number; y: number; alive: boolean };
  spawnEffects: Array<{ id: string; x: number; y: number; timer: number }>;
  powerUps: Array<{ id: string; kind: "shield" | "bomb" | "rebuild"; x: number; y: number; ttl: number }>;
  level: number;
  maxLevel: number;
  enemiesRemaining: number;
  status: "playing" | "won" | "lost";
  message: string;
  tick: number;
};

type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
};

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Missing #app element.");
}

const app = appElement;

const state = {
  ws: null as WebSocket | null,
  playerId: "",
  playerName: "",
  screen: "name" as "name" | "lobby" | "room" | "game" | "result",
  status: "连接中...",
  leavingRoom: false,
  rooms: [] as RoomSummary[],
  room: null as RoomState | null,
  game: null as GameSnapshot | null,
  input: { up: false, down: false, left: false, right: false, fire: false } as InputState
};

let renderedScreen = "";

connect();
render();
requestAnimationFrame(drawLoop);
app.addEventListener("click", handleAppClick);

window.addEventListener("keydown", (event) => {
  if (updateKey(event, true)) {
    event.preventDefault();
    sendInput();
  }
});

window.addEventListener("keyup", (event) => {
  if (updateKey(event, false)) {
    event.preventDefault();
    sendInput();
  }
});

function connect() {
  const wsUrl = resolveWebSocketUrl();
  state.ws = new WebSocket(wsUrl);

  state.ws.addEventListener("open", () => {
    state.status = "已连接服务器。";
    render();
  });

  state.ws.addEventListener("close", () => {
    state.status = `服务器连接断开，请确认后端服务可访问：${wsUrl}`;
    state.screen = "name";
    render();
  });

  state.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as { type: string; payload: any };
    switch (message.type) {
      case "connected":
        state.playerId = message.payload.playerId;
        break;
      case "nameAccepted":
        state.playerName = message.payload.name;
        state.screen = "lobby";
        state.status = `欢迎，${state.playerName}。`;
        break;
      case "roomList":
        state.rooms = message.payload;
        break;
      case "roomState":
        if (state.leavingRoom) {
          break;
        }
        state.room = message.payload;
        if (state.screen !== "game" && state.screen !== "result" && message.payload.status !== "playing") {
          state.screen = "room";
        }
        break;
      case "gameStart":
        state.leavingRoom = false;
        state.game = message.payload;
        state.screen = "game";
        break;
      case "gameSnapshot":
        state.game = message.payload;
        if (message.payload.status === "playing") {
          state.screen = "game";
        }
        if (state.screen === "game") {
          updateGameHud();
          return;
        }
        break;
      case "gameOver":
        state.status = message.payload.message;
        state.screen = "result";
        break;
      case "error":
        state.status = message.payload.message;
        break;
    }
    render();
  });
}

function resolveWebSocketUrl() {
  const configuredUrl = import.meta.env.VITE_WS_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }
  if (location.hostname.endsWith(".netlify.app")) {
    return "wss://tank-battle-du3j.onrender.com";
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.hostname}:8080`;
}

function render() {
  renderedScreen = state.screen;
  if (state.screen === "name") {
    app.innerHTML = `
      <main class="app hero">
        <section class="brand">
          <h1>坦克大战</h1>
          <p>输入你的战场代号，创建房间或加入好友房间。方向键或 WASD 移动，空格开火。像素炮塔已经预热，别让敌军穿过砖墙。</p>
        </section>
        <section class="panel stack">
          <h2>进入战场</h2>
          <input id="nameInput" maxlength="14" placeholder="昵称，全局不能重复" />
          <button data-action="set-name">确认昵称</button>
          <div class="status">${state.status}</div>
        </section>
      </main>
    `;
    bindActionButtons();
    return;
  }

  if (state.screen === "lobby") {
    app.innerHTML = `
      <main class="app layout">
        <section class="panel stack">
          <h2>大厅</h2>
          <p class="muted">当前代号：<strong>${escapeHtml(state.playerName)}</strong></p>
          <input id="roomInput" maxlength="16" placeholder="自定义房间号，例如 tiger01" />
          <button data-action="create-room">创建房间</button>
          <button data-action="join-room">按房间号加入</button>
          <div class="status">${state.status}</div>
        </section>
        <section class="panel stack">
          <div class="row"><h2>房间列表</h2><span class="muted">${state.rooms.length} 个房间</span></div>
          <div class="room-list">
            ${state.rooms.length ? state.rooms.map(roomCard).join("") : `<p class="muted">还没有房间，开一个吧。</p>`}
          </div>
        </section>
      </main>
    `;
    bindActionButtons();
    return;
  }

  if (state.screen === "room" && state.room) {
    const room = state.room;
    const me = currentPlayer(room);
    const isHost = Boolean(me?.host);
    const canStart = isHost && (room.players.length === 1 || room.players.every((player) => player.ready));
    app.innerHTML = `
      <main class="app layout">
        <section class="panel stack">
          <h2>房间 ${escapeHtml(room.id)}</h2>
          <p class="muted">最多 2 人。单人可直接开始；双人需要两人都准备，再由房主开始。</p>
          <button data-action="ready">${me?.ready ? "取消准备" : "准备"}</button>
          <button data-action="start-game" ${canStart ? "" : "disabled"}>开始游戏</button>
          <button data-action="leave-room" class="danger">离开房间</button>
          <div class="status">${state.status}</div>
        </section>
        <section class="panel stack">
          <div class="row"><h2>玩家</h2><span class="muted">${room.players.length}/2</span></div>
          <div class="players">
            ${room.players.map((player) => playerRow(player, isHost)).join("")}
          </div>
        </section>
      </main>
    `;
    bindActionButtons();
    return;
  }

  if (state.screen === "game") {
    if (renderedScreen === "game" && document.querySelector("#battlefield")) {
      updateGameHud();
      return;
    }
    app.innerHTML = `
      <main class="app game-shell">
        <canvas id="battlefield" width="640" height="480"></canvas>
        <aside class="panel hud">
          <h2>战斗中</h2>
          <p class="muted">移动 <span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> 或方向键</p>
          <p class="muted">开火 <span class="kbd">Space</span></p>
          <div id="scoreboard">${scoreboard()}</div>
          <button data-action="leave-battle" class="danger">撤离房间</button>
          <div class="status">${state.status}</div>
        </aside>
      </main>
    `;
    bindActionButtons();
    draw();
    return;
  }

  if (state.screen === "result") {
    app.innerHTML = `
      <main class="app hero">
        <section class="brand">
          <h1>${state.game?.status === "won" ? "胜利" : "战败"}</h1>
          <p>${state.status}</p>
        </section>
        <section class="panel stack">
          <h2>战斗结束</h2>
          <div>${scoreboard()}</div>
          <button data-action="back-lobby">回到大厅</button>
        </section>
      </main>
    `;
    bindActionButtons();
  }
}

function roomCard(room: RoomSummary) {
  const disabled = room.count >= room.max || room.status === "playing" ? "disabled" : "";
  return `
    <article class="room-card">
      <div class="row"><strong>${escapeHtml(room.id)}</strong><span>${room.count}/${room.max}</span></div>
      <div class="muted">房主：${escapeHtml(room.hostName)} · ${room.status === "playing" ? "战斗中" : "等待中"}</div>
      <button data-action="join-listed-room" data-room-id="${escapeHtml(room.id)}" ${disabled}>加入</button>
    </article>
  `;
}

function playerRow(player: RoomState["players"][number], isHost: boolean) {
  const kick = isHost && !player.host ? `<button class="danger" data-action="kick-player" data-player-id="${player.id}">踢出</button>` : "<span></span>";
  return `
    <div class="player-row">
      <strong>${escapeHtml(player.name)}${player.host ? "（房主）" : ""}</strong>
      <span class="${player.ready ? "ready" : "muted"}">${player.ready ? "已准备" : "未准备"}</span>
      ${kick}
    </div>
  `;
}

function scoreboard() {
  if (!state.game) {
    return "";
  }
  const players = state.game.tanks.filter((tank) => tank.kind === "player");
  const enemies = state.game.tanks.filter((tank) => tank.kind === "enemy" && tank.alive).length;
  return `
    <div class="stack">
      <p>关卡：${state.game.level}/${state.game.maxLevel}</p>
      ${players.map((tank) => `<p>${escapeHtml(tank.name)}：${tank.alive ? `${tank.lives} 命` : "阵亡"}</p>`).join("")}
      <p>场上敌军：${enemies}</p>
      <p>待出现敌军：${state.game.enemiesRemaining}</p>
      <p>基地：${state.game.base.alive ? "安全" : "被摧毁"}</p>
      <p>道具：${state.game.powerUps.length} 个</p>
    </div>
  `;
}

function updateGameHud() {
  const scoreboardElement = document.querySelector<HTMLDivElement>("#scoreboard");
  if (scoreboardElement) {
    scoreboardElement.innerHTML = scoreboard();
  }
}

function drawLoop() {
  draw();
  requestAnimationFrame(drawLoop);
}

function draw() {
  const canvas = document.querySelector<HTMLCanvasElement>("#battlefield");
  const game = state.game;
  if (!canvas || !game) {
    return;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#10130f";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawGrid(ctx);
  drawBase(ctx, game.base);
  for (const wall of game.walls) {
    ctx.fillStyle = wall.hp > 1 ? "#9c5a32" : "#684026";
    ctx.fillRect(wall.x + 1, wall.y + 1, 30, 30);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(wall.x + 4, wall.y + 14, 24, 4);
    ctx.fillRect(wall.x + 14, wall.y + 4, 4, 24);
  }
  for (const effect of game.spawnEffects) {
    drawSpawnStar(ctx, effect);
  }
  for (const powerUp of game.powerUps) {
    drawPowerUp(ctx, powerUp);
  }
  for (const tank of game.tanks) {
    if (tank.alive) {
      drawTank(ctx, tank);
    }
  }
  for (const bush of game.bushes) {
    drawBush(ctx, bush);
  }
  for (const bullet of game.bullets) {
    ctx.fillStyle = bullet.ownerKind === "player" ? "#ffe780" : "#ff735d";
    ctx.fillRect(bullet.x, bullet.y, 6, 6);
  }
}

function drawBase(ctx: CanvasRenderingContext2D, base: GameSnapshot["base"]) {
  ctx.fillStyle = base.alive ? "#f2d27a" : "#5b2b24";
  ctx.fillRect(base.x + 6, base.y + 12, 20, 18);
  ctx.fillRect(base.x + 12, base.y + 6, 8, 10);
  ctx.fillStyle = base.alive ? "#3a2a16" : "#1a100d";
  ctx.fillRect(base.x + 14, base.y + 9, 4, 13);
  ctx.fillStyle = base.alive ? "#ffd15c" : "#2b1915";
  ctx.fillRect(base.x + 2, base.y + 14, 8, 6);
  ctx.fillRect(base.x + 22, base.y + 14, 8, 6);
  ctx.fillRect(base.x + 0, base.y + 20, 10, 5);
  ctx.fillRect(base.x + 22, base.y + 20, 10, 5);
  ctx.fillStyle = base.alive ? "#fff0b3" : "#160d0b";
  ctx.fillRect(base.x + 9, base.y + 26, 14, 3);
}

function drawSpawnStar(ctx: CanvasRenderingContext2D, effect: GameSnapshot["spawnEffects"][number]) {
  const visible = Math.floor(effect.timer / 7) % 2 === 0;
  if (!visible) {
    return;
  }
  const cx = effect.x + 13;
  const cy = effect.y + 13;
  ctx.fillStyle = "#fff6a6";
  ctx.fillRect(cx - 2, cy - 13, 4, 26);
  ctx.fillRect(cx - 13, cy - 2, 26, 4);
  ctx.fillStyle = "#ff9f43";
  ctx.fillRect(cx - 7, cy - 7, 14, 14);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(cx - 3, cy - 3, 6, 6);
}

function drawPowerUp(ctx: CanvasRenderingContext2D, powerUp: GameSnapshot["powerUps"][number]) {
  const pulse = Math.floor(powerUp.ttl / 10) % 2 === 0;
  ctx.fillStyle = pulse ? "#f3ffd0" : "#ffd15c";
  ctx.fillRect(powerUp.x, powerUp.y, 24, 24);
  ctx.fillStyle = powerUp.kind === "shield" ? "#5fb6ff" : powerUp.kind === "bomb" ? "#ff6b57" : "#7bd36a";
  ctx.fillRect(powerUp.x + 3, powerUp.y + 3, 18, 18);
  ctx.fillStyle = "#10130f";
  if (powerUp.kind === "shield") {
    ctx.fillRect(powerUp.x + 8, powerUp.y + 6, 8, 3);
    ctx.fillRect(powerUp.x + 6, powerUp.y + 9, 12, 5);
    ctx.fillRect(powerUp.x + 9, powerUp.y + 14, 6, 5);
  } else if (powerUp.kind === "bomb") {
    ctx.fillRect(powerUp.x + 7, powerUp.y + 8, 10, 10);
    ctx.fillRect(powerUp.x + 14, powerUp.y + 5, 4, 4);
  } else {
    ctx.fillRect(powerUp.x + 6, powerUp.y + 9, 12, 3);
    ctx.fillRect(powerUp.x + 10, powerUp.y + 5, 4, 13);
  }
}

function drawBush(ctx: CanvasRenderingContext2D, bush: GameSnapshot["bushes"][number]) {
  ctx.fillStyle = "rgba(46, 113, 49, 0.92)";
  ctx.fillRect(bush.x, bush.y, bush.size, bush.size);
  ctx.fillStyle = "rgba(139, 214, 94, 0.55)";
  ctx.fillRect(bush.x + 4, bush.y + 5, 10, 7);
  ctx.fillRect(bush.x + 17, bush.y + 10, 11, 8);
  ctx.fillRect(bush.x + 8, bush.y + 21, 16, 6);
}

function drawGrid(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  for (let x = 0; x <= 640; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 480);
    ctx.stroke();
  }
  for (let y = 0; y <= 480; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(640, y);
    ctx.stroke();
  }
}

function drawTank(ctx: CanvasRenderingContext2D, tank: Tank) {
  const color = tank.kind === "player" ? (tank.id === state.playerId ? "#7bd36a" : "#5fb6ff") : "#e05648";
  ctx.fillStyle = "#090d07";
  ctx.fillRect(tank.x - 2, tank.y + 4, 6, 18);
  ctx.fillRect(tank.x + 22, tank.y + 4, 6, 18);
  ctx.fillStyle = color;
  ctx.fillRect(tank.x + 3, tank.y + 3, 20, 20);
  ctx.fillStyle = "#f3ffd0";
  ctx.fillRect(tank.x + 9, tank.y + 9, 8, 8);
  const barrel = barrelRect(tank);
  ctx.fillStyle = color;
  ctx.fillRect(barrel.x, barrel.y, barrel.w, barrel.h);
  if (tank.shieldUntil && (tank.shieldHits ?? 0) > 0) {
    ctx.strokeStyle = "#8ee7ff";
    ctx.lineWidth = 3;
    ctx.strokeRect(tank.x - 4, tank.y - 4, 34, 34);
    ctx.lineWidth = 1;
  }
}

function barrelRect(tank: Tank) {
  switch (tank.dir) {
    case "up":
      return { x: tank.x + 11, y: tank.y - 8, w: 4, h: 13 };
    case "down":
      return { x: tank.x + 11, y: tank.y + 21, w: 4, h: 13 };
    case "left":
      return { x: tank.x - 8, y: tank.y + 11, w: 13, h: 4 };
    case "right":
      return { x: tank.x + 21, y: tank.y + 11, w: 13, h: 4 };
  }
}

function updateKey(event: KeyboardEvent, pressed: boolean) {
  const key = (event.key || event.code || "").toLowerCase();
  if (!key) {
    return false;
  }
  const previous = JSON.stringify(state.input);
  if (key === "arrowup" || key === "keyw" || key === "w") state.input.up = pressed;
  if (key === "arrowdown" || key === "keys" || key === "s") state.input.down = pressed;
  if (key === "arrowleft" || key === "keya" || key === "a") state.input.left = pressed;
  if (key === "arrowright" || key === "keyd" || key === "d") state.input.right = pressed;
  if (key === " " || key === "space" || key === "spacebar") state.input.fire = pressed;
  return previous !== JSON.stringify(state.input);
}

function sendInput() {
  if (state.screen === "game") {
    send("input", state.input);
  }
}

function roomInputValue() {
  return document.querySelector<HTMLInputElement>("#roomInput")?.value ?? "";
}

function currentPlayer(room: RoomState) {
  return room.players.find((player) => player.id === state.playerId) ?? room.players.find((player) => player.name === state.playerName);
}

function handleAppClick(event: MouseEvent) {
  const button = buttonFromEventTarget(event.target);
  runButtonAction(button);
}

function bindActionButtons() {
  document.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      runButtonAction(button);
    };
  });
}

function buttonFromEventTarget(target: EventTarget | null) {
  if (target instanceof Element) {
    return target.closest<HTMLButtonElement>("button[data-action]");
  }
  if (target instanceof Node && target.parentElement) {
    return target.parentElement.closest<HTMLButtonElement>("button[data-action]");
  }
  return null;
}

function runButtonAction(button: HTMLButtonElement | null) {
  if (!button || button.disabled) {
    return;
  }
  const action = button.dataset.action;
  if (action === "set-name") {
    state.leavingRoom = false;
    const input = document.querySelector<HTMLInputElement>("#nameInput");
    send("setName", { name: input?.value ?? "" });
  }
  if (action === "create-room") {
    state.leavingRoom = false;
    send("createRoom", { roomId: roomInputValue() });
  }
  if (action === "join-room") {
    state.leavingRoom = false;
    send("joinRoom", { roomId: roomInputValue() });
  }
  if (action === "join-listed-room") {
    state.leavingRoom = false;
    send("joinRoom", { roomId: button.dataset.roomId ?? "" });
  }
  if (action === "ready") {
    const me = state.room ? currentPlayer(state.room) : undefined;
    state.status = me?.ready ? "已取消准备。" : "已发送准备状态。";
    send("ready", { ready: !me?.ready });
    render();
  }
  if (action === "start-game") {
    state.status = "正在开始游戏...";
    render();
    send("startGame", {});
  }
  if (action === "kick-player") {
    send("kickPlayer", { playerId: button.dataset.playerId ?? "" });
  }
  if (action === "leave-room") {
    state.leavingRoom = true;
    send("leaveRoom", {});
    state.room = null;
    state.status = "已离开房间。";
    state.screen = "lobby";
    render();
  }
  if (action === "leave-battle" || action === "back-lobby") {
    state.leavingRoom = true;
    send("leaveRoom", {});
    state.game = null;
    state.room = null;
    state.screen = "lobby";
    render();
  }
}

function send(type: string, payload: unknown) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type, payload }));
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}
