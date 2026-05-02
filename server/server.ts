import { WebSocket, WebSocketServer } from "ws";

type Direction = "up" | "down" | "left" | "right";

type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
};

type ClientMessage =
  | { type: "setName"; payload: { name: string } }
  | { type: "createRoom"; payload: { roomId: string } }
  | { type: "joinRoom"; payload: { roomId: string } }
  | { type: "leaveRoom"; payload?: Record<string, never> }
  | { type: "ready"; payload: { ready: boolean } }
  | { type: "kickPlayer"; payload: { playerId: string } }
  | { type: "startGame"; payload?: Record<string, never> }
  | { type: "input"; payload: InputState };

type Client = {
  id: string;
  ws: WebSocket;
  name: string | null;
  roomId: string | null;
  ready: boolean;
  input: InputState;
};

type Room = {
  id: string;
  hostId: string;
  playerIds: string[];
  game: GameState | null;
};

type Tank = {
  id: string;
  name: string;
  kind: "player" | "enemy";
  x: number;
  y: number;
  dir: Direction;
  lives: number;
  cooldown: number;
  aiTimer: number;
  alive: boolean;
  shieldUntil?: number;
  shieldHits?: number;
};

type Bullet = {
  id: string;
  ownerId: string;
  ownerKind: "player" | "enemy";
  x: number;
  y: number;
  dir: Direction;
};

type Wall = {
  id: string;
  x: number;
  y: number;
  hp: number;
};

type Base = {
  x: number;
  y: number;
  alive: boolean;
};

type Bush = {
  id: string;
  x: number;
  y: number;
  size: number;
};

type SpawnEffect = {
  id: string;
  x: number;
  y: number;
  timer: number;
};

type PowerUpKind = "shield" | "bomb" | "rebuild";

type PowerUp = {
  id: string;
  kind: PowerUpKind;
  x: number;
  y: number;
  ttl: number;
};

type GameState = {
  width: number;
  height: number;
  tanks: Tank[];
  bullets: Bullet[];
  walls: Wall[];
  bushes: Bush[];
  base: Base;
  spawnEffects: SpawnEffect[];
  powerUps: PowerUp[];
  level: number;
  maxLevel: number;
  enemiesRemaining: number;
  enemiesSpawned: number;
  spawnCooldown: number;
  nextEnemyId: number;
  nextPowerUpId: number;
  status: "playing" | "won" | "lost";
  message: string;
  tick: number;
};

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = 1000 / 30;
const WORLD_WIDTH = 640;
const WORLD_HEIGHT = 480;
const TILE = 32;
const TANK_SIZE = 26;
const BULLET_SIZE = 6;
const BASE_SIZE = 32;
const POWERUP_SIZE = 24;
const SHIELD_DURATION_TICKS = 30 * 30;
const PLAYER_SPAWNS = [
  { x: 112, y: 384, dir: "up" as Direction },
  { x: 496, y: 384, dir: "up" as Direction }
];

const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();
let nextClientId = 1;
let nextBulletId = 1;

const emptyInput = (): InputState => ({
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false
});

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  const client: Client = {
    id: `p${nextClientId++}`,
    ws,
    name: null,
    roomId: null,
    ready: false,
    input: emptyInput()
  };
  clients.set(client.id, client);
  send(client, "connected", { playerId: client.id });
  broadcastRoomList();

  ws.on("message", (raw) => handleMessage(client, raw.toString()));
  ws.on("close", () => removeClient(client));
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.game || room.game.status !== "playing") {
      continue;
    }
    updateGame(room);
    broadcast(room, "gameSnapshot", snapshot(room.game));
    if (room.game.status !== "playing") {
      broadcast(room, "gameOver", { status: room.game.status, message: room.game.message });
      broadcastRoomList();
    }
  }
}, TICK_MS);

console.log(`Tank Battle WebSocket server listening on ws://0.0.0.0:${PORT}`);

function handleMessage(client: Client, raw: string) {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    sendError(client, "消息格式错误。");
    return;
  }

  switch (message.type) {
    case "setName":
      setName(client, message.payload.name);
      break;
    case "createRoom":
      createRoom(client, message.payload.roomId);
      break;
    case "joinRoom":
      joinRoom(client, message.payload.roomId);
      break;
    case "leaveRoom":
      leaveRoom(client);
      break;
    case "ready":
      setReady(client, message.payload.ready);
      break;
    case "kickPlayer":
      kickPlayer(client, message.payload.playerId);
      break;
    case "startGame":
      startGame(client);
      break;
    case "input":
      client.input = normalizeInput(message.payload);
      break;
  }
}

function setName(client: Client, name: string) {
  const cleanName = name.trim().slice(0, 14);
  if (!cleanName) {
    sendError(client, "请输入昵称。");
    return;
  }
  const duplicated = [...clients.values()].some((other) => other.id !== client.id && other.name === cleanName);
  if (duplicated) {
    sendError(client, "这个昵称已经在线了，换一个更响亮的代号吧。");
    return;
  }
  client.name = cleanName;
  send(client, "nameAccepted", { playerId: client.id, name: cleanName });
  broadcastRoomList();
}

function createRoom(client: Client, roomId: string) {
  if (!client.name) {
    sendError(client, "请先设置昵称。");
    return;
  }
  const cleanRoomId = roomId.trim().slice(0, 16);
  if (!/^[\w\u4e00-\u9fa5-]{2,16}$/.test(cleanRoomId)) {
    sendError(client, "房间号需要 2-16 位，可用中文、字母、数字、下划线或短横线。");
    return;
  }
  if (rooms.has(cleanRoomId)) {
    sendError(client, "房间号已经存在。");
    return;
  }
  leaveRoom(client);
  const room: Room = {
    id: cleanRoomId,
    hostId: client.id,
    playerIds: [client.id],
    game: null
  };
  client.roomId = room.id;
  client.ready = false;
  rooms.set(room.id, room);
  broadcastRoomState(room);
  broadcastRoomList();
}

function joinRoom(client: Client, roomId: string) {
  if (!client.name) {
    sendError(client, "请先设置昵称。");
    return;
  }
  const room = rooms.get(roomId.trim());
  if (!room) {
    sendError(client, "没有找到这个房间。");
    return;
  }
  if (room.playerIds.includes(client.id)) {
    return;
  }
  if (room.playerIds.length >= 2) {
    sendError(client, "房间已经满员。");
    return;
  }
  if (room.game?.status === "playing") {
    sendError(client, "战斗已经开始，暂时不能加入。");
    return;
  }
  leaveRoom(client);
  client.roomId = room.id;
  client.ready = false;
  room.playerIds.push(client.id);
  broadcastRoomState(room);
  broadcastRoomList();
}

function leaveRoom(client: Client) {
  if (!client.roomId) {
    return;
  }
  const room = rooms.get(client.roomId);
  client.roomId = null;
  client.ready = false;
  client.input = emptyInput();
  if (!room) {
    return;
  }
  room.playerIds = room.playerIds.filter((id) => id !== client.id);
  if (room.playerIds.length === 0) {
    rooms.delete(room.id);
  } else {
    if (room.hostId === client.id) {
      room.hostId = room.playerIds[0];
    }
    room.game = null;
    broadcast(room, "error", { message: "有玩家离开，战斗已回到等待状态。" });
    broadcastRoomState(room);
  }
  broadcastRoomList();
}

function setReady(client: Client, ready: boolean) {
  const room = getClientRoom(client);
  if (!room) {
    sendError(client, "你还没有进入房间。");
    return;
  }
  if (room.game?.status === "playing") {
    return;
  }
  client.ready = Boolean(ready);
  broadcastRoomState(room);
}

function kickPlayer(client: Client, playerId: string) {
  const room = getClientRoom(client);
  const target = clients.get(playerId);
  if (!room || room.hostId !== client.id || !target || target.id === client.id || target.roomId !== room.id) {
    sendError(client, "只有房主可以踢出房间内的其他玩家。");
    return;
  }
  send(target, "error", { message: "你被房主请出了房间。" });
  leaveRoom(target);
}

function startGame(client: Client) {
  const room = getClientRoom(client);
  if (!room || room.hostId !== client.id) {
    sendError(client, "只有房主可以开始游戏。");
    return;
  }
  if (room.playerIds.length === 2) {
    const allReady = room.playerIds.every((id) => clients.get(id)?.ready);
    if (!allReady) {
      sendError(client, "双人模式需要两名玩家都准备。");
      return;
    }
  }
  room.game = createGame(room);
  broadcastRoomState(room);
  broadcastRoomList();
  broadcast(room, "gameStart", snapshot(room.game));
}

function createGame(room: Room): GameState {
  const tanks: Tank[] = room.playerIds.map((id, index) => {
    const client = clients.get(id);
    const spawn = PLAYER_SPAWNS[index];
    return {
      id,
      name: client?.name ?? "玩家",
      kind: "player",
      x: spawn.x,
      y: spawn.y,
      dir: spawn.dir,
      lives: 3,
      cooldown: 0,
      aiTimer: 0,
      alive: true
    };
  });
  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    tanks,
    bullets: [],
    walls: createWalls(),
    bushes: createBushes(),
    base: { x: 304, y: 432, alive: true },
    spawnEffects: [],
    powerUps: [],
    level: 1,
    maxLevel: 10,
    enemiesRemaining: enemiesForLevel(1),
    enemiesSpawned: 0,
    spawnCooldown: 1,
    nextEnemyId: 1,
    nextPowerUpId: 1,
    status: "playing",
    message: "第 1 关",
    tick: 0
  };
}

function createWalls(): Wall[] {
  const coords = [
    [5, 4], [6, 4], [7, 4], [12, 4], [13, 4], [14, 4],
    [2, 7], [3, 7], [4, 7], [9, 7], [10, 7], [15, 7], [16, 7], [17, 7],
    [5, 10], [6, 10], [7, 10], [12, 10], [13, 10], [14, 10],
    [9, 12], [10, 12], [8, 13], [11, 13], [8, 14], [11, 14]
  ];
  return coords.map(([x, y], index) => ({ id: `w${index}`, x: x * TILE, y: y * TILE, hp: 2 }));
}

function createBushes(): Bush[] {
  const coords = [
    [1, 3], [2, 3], [16, 3], [17, 3],
    [6, 6], [7, 6], [8, 6], [11, 6], [12, 6], [13, 6],
    [1, 11], [2, 11], [17, 11], [18, 11],
    [6, 13], [13, 13]
  ];
  return coords.map(([x, y], index) => ({ id: `g${index}`, x: x * TILE, y: y * TILE, size: TILE }));
}

function updateGame(room: Room) {
  const game = room.game;
  if (!game) {
    return;
  }
  game.tick += 1;
  spawnEnemies(game);
  updateSpawnEffects(game);
  maybeSpawnPowerUp(game);
  for (const tank of game.tanks) {
    if (!tank.alive) {
      continue;
    }
    tank.cooldown = Math.max(0, tank.cooldown - 1);
    if (tank.shieldUntil && tank.shieldUntil <= game.tick) {
      tank.shieldUntil = undefined;
      tank.shieldHits = 0;
    }
    if (tank.kind === "player") {
      updatePlayerTank(game, tank);
    } else {
      updateEnemyTank(game, tank);
    }
  }
  updateBullets(game);
  collectPowerUps(game);
  game.walls = game.walls.filter((wall) => wall.hp > 0);
  const playersAlive = game.tanks.some((tank) => tank.kind === "player" && tank.alive);
  const enemiesAlive = game.tanks.some((tank) => tank.kind === "enemy" && tank.alive);
  if (!playersAlive || !game.base.alive) {
    game.status = "lost";
    game.message = game.base.alive ? "全员阵亡，整备后再战！" : "基地被摧毁，闯关失败！";
  } else if (game.enemiesRemaining <= 0 && !enemiesAlive) {
    advanceLevel(game);
  }
}

function spawnEnemies(game: GameState) {
  const activeEnemies = game.tanks.filter((tank) => tank.kind === "enemy" && tank.alive).length;
  const pendingEnemies = game.spawnEffects.length;
  const maxActive = Math.min(2 + Math.ceil(game.level / 2), 7);
  if (game.enemiesRemaining <= 0 || activeEnemies + pendingEnemies >= maxActive) {
    return;
  }
  game.spawnCooldown -= 1;
  if (game.spawnCooldown > 0) {
    return;
  }
  const spawns = [
    { x: 80, y: 16 },
    { x: 304, y: 16 },
    { x: 528, y: 16 }
  ];
  const spawn = spawns[game.enemiesSpawned % spawns.length];
  const blocked = game.tanks.some((tank) => tank.alive && intersects(spawn, TANK_SIZE, tank, TANK_SIZE));
  if (blocked) {
    game.spawnCooldown = 15;
    return;
  }
  game.spawnEffects.push({
    id: `s${game.level}-${game.nextEnemyId}`,
    x: spawn.x,
    y: spawn.y,
    timer: 45
  });
  game.enemiesRemaining -= 1;
  game.enemiesSpawned += 1;
  game.spawnCooldown = spawnIntervalForLevel(game.level);
}

function updateSpawnEffects(game: GameState) {
  const pending: SpawnEffect[] = [];
  for (const effect of game.spawnEffects) {
    effect.timer -= 1;
    if (effect.timer > 0) {
      pending.push(effect);
      continue;
    }
    createEnemyAt(game, effect.x, effect.y);
  }
  game.spawnEffects = pending;
}

function createEnemyAt(game: GameState, x: number, y: number) {
  const id = `e${game.level}-${game.nextEnemyId++}`;
  game.tanks.push({
    id,
    name: `敌军 ${id}`,
    kind: "enemy",
    x,
    y,
    dir: "down",
    lives: game.level >= 7 ? 2 : 1,
    cooldown: 15,
    aiTimer: 18,
    alive: true
  });
}

function advanceLevel(game: GameState) {
  if (game.level >= game.maxLevel) {
    game.status = "won";
    game.message = "10 关全部突破，胜利！";
    return;
  }
  game.level += 1;
  game.message = `第 ${game.level} 关`;
  game.bullets = [];
  game.spawnEffects = [];
  game.powerUps = [];
  game.tanks = game.tanks.filter((tank) => tank.kind === "player" && tank.alive);
  game.tanks.forEach((tank, index) => {
    const spawn = PLAYER_SPAWNS[index] ?? PLAYER_SPAWNS[0];
    tank.x = spawn.x;
    tank.y = spawn.y;
    tank.dir = spawn.dir;
    tank.cooldown = 0;
    tank.aiTimer = 0;
  });
  game.walls = createWalls();
  game.bushes = createBushes();
  game.base = { x: 304, y: 432, alive: true };
  game.enemiesRemaining = enemiesForLevel(game.level);
  game.enemiesSpawned = 0;
  game.spawnCooldown = 45;
}

function enemiesForLevel(level: number) {
  return Math.min(4 + level * 2, 24);
}

function spawnIntervalForLevel(level: number) {
  return Math.max(18, 92 - level * 7);
}

function maybeSpawnPowerUp(game: GameState) {
  game.powerUps = game.powerUps.filter((powerUp) => {
    powerUp.ttl -= 1;
    return powerUp.ttl > 0;
  });
  if (game.powerUps.length >= 2 || game.tick % 240 !== 0 || Math.random() > 0.45) {
    return;
  }
  const spot = randomOpenPowerUpSpot(game);
  if (!spot) {
    return;
  }
  const kinds: PowerUpKind[] = ["shield", "bomb", "rebuild"];
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  game.powerUps.push({
    id: `p${game.nextPowerUpId++}`,
    kind,
    x: spot.x,
    y: spot.y,
    ttl: 30 * 18
  });
}

function randomOpenPowerUpSpot(game: GameState) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const x = (1 + Math.floor(Math.random() * 18)) * TILE + 4;
    const y = (2 + Math.floor(Math.random() * 11)) * TILE + 4;
    const candidate = { x, y };
    const blocked =
      game.walls.some((wall) => intersects(candidate, POWERUP_SIZE, wall, TILE)) ||
      game.base.alive && intersects(candidate, POWERUP_SIZE, game.base, BASE_SIZE) ||
      game.tanks.some((tank) => tank.alive && intersects(candidate, POWERUP_SIZE, tank, TANK_SIZE)) ||
      game.powerUps.some((powerUp) => intersects(candidate, POWERUP_SIZE, powerUp, POWERUP_SIZE));
    if (!blocked) {
      return candidate;
    }
  }
  return null;
}

function collectPowerUps(game: GameState) {
  const remaining: PowerUp[] = [];
  for (const powerUp of game.powerUps) {
    const collector = game.tanks.find((tank) => tank.kind === "player" && tank.alive && intersects(tank, TANK_SIZE, powerUp, POWERUP_SIZE));
    if (!collector) {
      remaining.push(powerUp);
      continue;
    }
    applyPowerUp(game, collector, powerUp.kind);
  }
  game.powerUps = remaining;
}

function applyPowerUp(game: GameState, tank: Tank, kind: PowerUpKind) {
  if (kind === "shield") {
    tank.shieldUntil = game.tick + SHIELD_DURATION_TICKS;
    tank.shieldHits = 1;
    game.message = `${tank.name} 获得保护罩`;
  }
  if (kind === "bomb") {
    game.tanks.forEach((candidate) => {
      if (candidate.kind === "enemy") {
        candidate.alive = false;
      }
    });
    game.spawnEffects = [];
    game.message = "炸弹引爆，场上敌军全灭！";
  }
  if (kind === "rebuild") {
    game.base = { x: 304, y: 432, alive: true };
    game.walls = mergeWalls(game.walls, createBaseWalls());
    game.message = "基地重铸完成！";
  }
}

function createBaseWalls(): Wall[] {
  const coords = [[9, 12], [10, 12], [8, 13], [11, 13], [8, 14], [11, 14]];
  return coords.map(([x, y], index) => ({ id: `bw${index}-${Date.now()}`, x: x * TILE, y: y * TILE, hp: 2 }));
}

function mergeWalls(existing: Wall[], additions: Wall[]) {
  const merged = [...existing];
  for (const wall of additions) {
    const duplicate = merged.some((candidate) => candidate.x === wall.x && candidate.y === wall.y);
    if (!duplicate) {
      merged.push(wall);
    }
  }
  return merged;
}

function updatePlayerTank(game: GameState, tank: Tank) {
  const client = clients.get(tank.id);
  const input = client?.input ?? emptyInput();
  const desired = input.up ? "up" : input.down ? "down" : input.left ? "left" : input.right ? "right" : null;
  if (desired) {
    tank.dir = desired;
    moveTank(game, tank, desired, 3);
  }
  if (input.fire) {
    shoot(game, tank);
  }
}

function updateEnemyTank(game: GameState, tank: Tank) {
  tank.aiTimer -= 1;
  if (tank.aiTimer <= 0) {
    const dirs: Direction[] = ["up", "down", "left", "right"];
    tank.dir = dirs[Math.floor(Math.random() * dirs.length)];
    tank.aiTimer = 18 + Math.floor(Math.random() * 35);
  }
  moveTank(game, tank, tank.dir, 1.6);
  if (Math.random() < 0.035) {
    shoot(game, tank);
  }
}

function moveTank(game: GameState, tank: Tank, dir: Direction, speed: number) {
  const vector = directionVector(dir);
  const next = { ...tank, x: tank.x + vector.x * speed, y: tank.y + vector.y * speed };
  if (next.x < 0 || next.y < 0 || next.x + TANK_SIZE > game.width || next.y + TANK_SIZE > game.height) {
    return;
  }
  const blockedByWall = game.walls.some((wall) => intersects(next, TANK_SIZE, wall, TILE));
  const blockedByBase = game.base.alive && intersects(next, TANK_SIZE, game.base, BASE_SIZE);
  const blockedByTank = game.tanks.some((other) => other.id !== tank.id && other.alive && intersects(next, TANK_SIZE, other, TANK_SIZE));
  if (blockedByBase && tank.kind === "enemy") {
    game.base.alive = false;
    return;
  }
  if (!blockedByWall && !blockedByTank && !blockedByBase) {
    tank.x = next.x;
    tank.y = next.y;
  }
}

function shoot(game: GameState, tank: Tank) {
  if (tank.cooldown > 0) {
    return;
  }
  const vector = directionVector(tank.dir);
  game.bullets.push({
    id: `b${nextBulletId++}`,
    ownerId: tank.id,
    ownerKind: tank.kind,
    x: tank.x + TANK_SIZE / 2 - BULLET_SIZE / 2 + vector.x * 16,
    y: tank.y + TANK_SIZE / 2 - BULLET_SIZE / 2 + vector.y * 16,
    dir: tank.dir
  });
  tank.cooldown = tank.kind === "player" ? 14 : 35;
}

function updateBullets(game: GameState) {
  const movedBullets: Bullet[] = [];
  for (const bullet of game.bullets) {
    const vector = directionVector(bullet.dir);
    bullet.x += vector.x * 7;
    bullet.y += vector.y * 7;
    if (bullet.x < 0 || bullet.y < 0 || bullet.x > game.width || bullet.y > game.height) {
      continue;
    }
    movedBullets.push(bullet);
  }

  const canceledBulletIds = findCanceledBulletIds(movedBullets);
  const nextBullets: Bullet[] = [];
  for (const bullet of movedBullets) {
    if (canceledBulletIds.has(bullet.id)) {
      continue;
    }
    if (game.base.alive && intersects(bullet, BULLET_SIZE, game.base, BASE_SIZE)) {
      game.base.alive = false;
      continue;
    }
    const wall = game.walls.find((candidate) => intersects(bullet, BULLET_SIZE, candidate, TILE));
    if (wall) {
      wall.hp -= 1;
      continue;
    }
    const target = game.tanks.find((tank) => {
      if (!tank.alive || tank.id === bullet.ownerId) {
        return false;
      }
      if (bullet.ownerKind === "player" && tank.kind === "player") {
        return false;
      }
      if (bullet.ownerKind === "enemy" && tank.kind === "enemy") {
        return false;
      }
      return intersects(bullet, BULLET_SIZE, tank, TANK_SIZE);
    });
    if (target) {
      if (target.kind === "player" && target.shieldUntil && target.shieldUntil > game.tick && (target.shieldHits ?? 0) > 0) {
        target.shieldHits = (target.shieldHits ?? 1) - 1;
        if (target.shieldHits <= 0) {
          target.shieldUntil = undefined;
        }
        continue;
      }
      target.lives -= 1;
      target.alive = target.lives > 0;
      continue;
    }
    nextBullets.push(bullet);
  }
  game.bullets = nextBullets;
}

function findCanceledBulletIds(bullets: Bullet[]) {
  const canceled = new Set<string>();
  for (let i = 0; i < bullets.length; i += 1) {
    const bullet = bullets[i];
    if (canceled.has(bullet.id)) {
      continue;
    }
    for (let j = i + 1; j < bullets.length; j += 1) {
      const other = bullets[j];
      if (canceled.has(other.id) || bullet.ownerKind === other.ownerKind) {
        continue;
      }
      if (intersects(bullet, BULLET_SIZE, other, BULLET_SIZE)) {
        canceled.add(bullet.id);
        canceled.add(other.id);
        break;
      }
    }
  }
  return canceled;
}

function directionVector(dir: Direction) {
  switch (dir) {
    case "up":
      return { x: 0, y: -1 };
    case "down":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

function intersects(a: { x: number; y: number }, aSize: number, b: { x: number; y: number }, bSize: number) {
  return a.x < b.x + bSize && a.x + aSize > b.x && a.y < b.y + bSize && a.y + aSize > b.y;
}

function getClientRoom(client: Client) {
  return client.roomId ? rooms.get(client.roomId) ?? null : null;
}

function removeClient(client: Client) {
  leaveRoom(client);
  clients.delete(client.id);
  broadcastRoomList();
}

function normalizeInput(input: InputState): InputState {
  return {
    up: Boolean(input?.up),
    down: Boolean(input?.down),
    left: Boolean(input?.left),
    right: Boolean(input?.right),
    fire: Boolean(input?.fire)
  };
}

function snapshot(game: GameState) {
  return {
    width: game.width,
    height: game.height,
    tanks: game.tanks,
    bullets: game.bullets,
    walls: game.walls,
    bushes: game.bushes,
    base: game.base,
    spawnEffects: game.spawnEffects,
    powerUps: game.powerUps,
    level: game.level,
    maxLevel: game.maxLevel,
    enemiesRemaining: game.enemiesRemaining,
    status: game.status,
    message: game.message,
    tick: game.tick
  };
}

function roomState(room: Room) {
  return {
    id: room.id,
    hostId: room.hostId,
    status: room.game?.status === "playing" ? "playing" : "waiting",
    players: room.playerIds.map((id) => {
      const client = clients.get(id);
      return {
        id,
        name: client?.name ?? "未知玩家",
        ready: Boolean(client?.ready),
        host: id === room.hostId
      };
    })
  };
}

function roomList() {
  return [...rooms.values()].map((room) => {
    const host = clients.get(room.hostId);
    return {
      id: room.id,
      hostName: host?.name ?? "未知房主",
      count: room.playerIds.length,
      max: 2,
      status: room.game?.status === "playing" ? "playing" : "waiting"
    };
  });
}

function broadcastRoomState(room: Room) {
  broadcast(room, "roomState", roomState(room));
}

function broadcastRoomList() {
  for (const client of clients.values()) {
    send(client, "roomList", roomList());
  }
}

function broadcast(room: Room, type: string, payload: unknown) {
  for (const id of room.playerIds) {
    const client = clients.get(id);
    if (client) {
      send(client, type, payload);
    }
  }
}

function sendError(client: Client, message: string) {
  send(client, "error", { message });
}

function send(client: Client, type: string, payload: unknown) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify({ type, payload }));
  }
}
