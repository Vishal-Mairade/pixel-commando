const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
let bullets = [];
let enemyBullets = [];

const stageBackgrounds = [];
for (let i = 1; i <= 8; i++) {
    const img = new Image();
    img.src = i === 1 ? "background.png" : "background-" + i + ".png";
    stageBackgrounds.push(img);
}

ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";

canvas.width = 960;
canvas.height = 540;

/* ================= SAVE (Your Original System) ================= */
let save = JSON.parse(localStorage.getItem("pixelSave")) || {
    coins: 0,
    unlockedLevel: 1,
    unlockedChars: [true, false, false, false, false],
    selectedChar: 0
};

function saveGame() {
    localStorage.setItem("pixelSave", JSON.stringify(save));
}

/* ================= STATE & CONSTANTS ================= */
let gameState = "home";
let menuIndex = 0;
let currentLevel = 1;
let selectedStage = 1;
let selectedLevel = 1;
const GRAVITY = 0.6;
let keys = {};
let enemies = [];
let boss = null;
let bossSpawned = false;


let mobileLeftBtn = null;
let mobileJumpBtn = null;
let mobileShootBtn = null;
let mobileRightBtn = null;
let touchLeft = false;
let touchJump = false;
let touchShoot = false;
let touchRight = false;

const LEVEL_WIDTH = 3000; // Total length of the level
const GROUND_Y = 400;
const TOTAL_STAGES = 8;
const LEVELS_PER_STAGE = 10;
const TOTAL_LEVELS = TOTAL_STAGES * LEVELS_PER_STAGE;

const menu = ["PLAY", "LEVELS", "SHOP"];
const WIN_BASE_REWARD = 100;
const SDK_MODES = ["none", "crazygames", "gamemonetize", "gamedistribution"];
let activeSdk = (localStorage.getItem("pixelActiveSdk") || (window.PLATFORM_SDK || "none")).toLowerCase();
if (!SDK_MODES.includes(activeSdk)) activeSdk = "none";

let lastCheckpoint = { x: 100, y: GROUND_Y - 75 };
let adClaimedOnWin = false;

/* ================= AUDIO ================= */
let audioCtx = null;
let masterGain = null;
let sdkForcedMute = false;
let isMuted = false;
const AUDIO_BTN = { x: 900, y: 18, w: 42, h: 32 };

function ensureAudio() {
    if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
        masterGain = audioCtx.createGain();
        masterGain.connect(audioCtx.destination);
        applyAudioState();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
}

function applyAudioState() {
    if (!masterGain || !audioCtx) return;
    const target = (isMuted || sdkForcedMute) ? 0.00001 : 0.9;
    const now = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(target, now, 0.02);
}

function playTone(freq, duration, type = "square", volume = 0.03, endFreq = null) {
    if (isMuted || sdkForcedMute) return;
    const ctx = ensureAudio();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq !== null) osc.frequency.linearRampToValueAtTime(endFreq, now + duration);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(now);
    osc.stop(now + duration + 0.01);
}

function playShootSound() { playTone(680, 0.08, "square", 0.06, 360); }
function playEnemyShootSound() { playTone(240, 0.09, "sawtooth", 0.05, 170); }
function playHitSound() { playTone(150, 0.12, "triangle", 0.07, 85); }
function playJumpSound() { playTone(260, 0.09, "square", 0.05, 430); }
function playWinSound() {
    playTone(520, 0.08, "triangle", 0.06, 620);
    setTimeout(() => playTone(700, 0.12, "triangle", 0.06, 860), 90);
}

/* ================= SDK MANAGER ================= */
let sdkReady = false;
let adInProgress = false;
let pendingRewardResolve = null;
let pendingRewardReject = null;

function loadScriptOnce(id, src, onLoad) {
    if (document.getElementById(id)) {
        if (onLoad) onLoad();
        return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.onload = () => onLoad && onLoad();
    script.onerror = () => console.warn("SDK load failed:", src);
    document.head.appendChild(script);
}

function setSdkAdActive(active) {
    sdkForcedMute = active;
    applyAudioState();
}

function waitForCondition(checker, timeoutMs = 8000, pollMs = 120) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (checker()) {
                clearInterval(timer);
                resolve(true);
                return;
            }
            if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                reject(new Error("timeout"));
            }
        }, pollMs);
    });
}

async function setupSdk() {
    if (activeSdk === "none") {
        sdkReady = true;
        return;
    }

    if (activeSdk === "crazygames") {
        try {
            await waitForCondition(() => window.CrazyGames && window.CrazyGames.SDK);
            // if (window.CrazyGames.SDK.init) await window.CrazyGames.SDK.init();
            sdkReady = true;
        } catch (err) {
            console.warn("CrazyGames init failed", err);
        }
        return;
    }

    if (activeSdk === "gamemonetize") {
        window.__PIXEL_SDK_EVENT = function (event) {
            if (!event || !event.name) return;
            switch (event.name) {
                case "SDK_READY":
                    sdkReady = true;
                    break;
                case "SDK_GAME_PAUSE":
                    if (adInProgress) setSdkAdActive(true);
                    break;
                case "SDK_GAME_START":
                    if (adInProgress) {
                        setSdkAdActive(false);
                        if (pendingRewardResolve) {
                            const resolve = pendingRewardResolve;
                            clearPendingReward();
                            resolve();
                        }
                    }
                    break;
                case "SDK_ERROR":
                    if (adInProgress && pendingRewardResolve) {
                        const reject = pendingRewardReject;
                        clearPendingReward();
                        if (reject) reject();
                    }
                    break;
            }
        };
        window.SDK_OPTIONS = window.SDK_OPTIONS || {};
        window.SDK_OPTIONS.gameId = window.SDK_OPTIONS.gameId || window.GM_GAME_ID || "your_gamemonetize_game_id";
        window.SDK_OPTIONS.onEvent = window.SDK_OPTIONS.onEvent || window.__PIXEL_SDK_EVENT;
        loadScriptOnce("gamemonetize-sdk", "https://api.gamemonetize.com/sdk.js");
        setTimeout(() => {
            if (typeof sdk !== "undefined") sdkReady = true;
        }, 1500);
        return;
    }

    if (activeSdk === "gamedistribution") {
        window.__PIXEL_SDK_EVENT = function (event) {
            if (!event || !event.name) return;
            switch (event.name) {
                case "SDK_READY":
                    sdkReady = true;
                    break;
                case "SDK_GAME_PAUSE":
                    if (adInProgress) setSdkAdActive(true);
                    break;
                case "SDK_GAME_START":
                    if (adInProgress) setSdkAdActive(false);
                    break;
            }
        };
        window.GD_OPTIONS = window.GD_OPTIONS || {};
        window.GD_OPTIONS.gameId = window.GD_OPTIONS.gameId || window.GD_GAME_ID || "your_gamedistribution_game_id";
        window.GD_OPTIONS.advertisementSettings = window.GD_OPTIONS.advertisementSettings || { autoplay: false };
        window.GD_OPTIONS.onEvent = window.GD_OPTIONS.onEvent || window.__PIXEL_SDK_EVENT;
        loadScriptOnce("gamedistribution-jssdk", "https://html5.api.gamedistribution.com/main.min.js");
    }
}

function clearPendingReward() {
    setSdkAdActive(false);
    adInProgress = false;
    pendingRewardResolve = null;
    pendingRewardReject = null;
}

function requestRewardedAd(onReward, onFail) {
    if (adInProgress) return;
    adInProgress = true;
    pendingRewardResolve = () => { clearPendingReward(); onReward(); };
    pendingRewardReject = () => { clearPendingReward(); if (onFail) onFail(); };

    if (activeSdk === "none") {
        setTimeout(() => pendingRewardResolve && pendingRewardResolve(), 400);
        return;
    }

    if (activeSdk === "crazygames" && window.CrazyGames && window.CrazyGames.SDK && window.CrazyGames.SDK.ad) {
        const callbacks = {
            adStarted: () => setSdkAdActive(true),
            adFinished: () => {
                setSdkAdActive(false);
                pendingRewardResolve && pendingRewardResolve();
            },
            adError: () => {
                setSdkAdActive(false);
                pendingRewardReject && pendingRewardReject();
            }
        };
        try {
            window.CrazyGames.SDK.ad.requestAd("rewarded", callbacks);
        } catch (err) {
            setSdkAdActive(false);
            pendingRewardReject && pendingRewardReject();
        }
        return;
    }

    if (activeSdk === "gamemonetize") {
        try {
            if (typeof sdk !== "undefined" && sdk) {
                setSdkAdActive(true);
                if (typeof sdk.showReward === "function") sdk.showReward();
                else if (typeof sdk.showAd === "function") sdk.showAd("rewarded");
                else if (typeof sdk.showBanner === "function") sdk.showBanner();
                else {
                    setSdkAdActive(false);
                    pendingRewardReject && pendingRewardReject();
                    return;
                }

                setTimeout(() => {
                    if (adInProgress && pendingRewardReject) {
                        setSdkAdActive(false);
                        pendingRewardReject();
                    }
                }, 9000);
            } else {
                pendingRewardReject && pendingRewardReject();
            }
        } catch (err) {
            pendingRewardReject && pendingRewardReject();
        }
        return;
    }

    if (activeSdk === "gamedistribution") {
        try {
            if (window.gdsdk && typeof window.gdsdk.showAd === "function") {
                setSdkAdActive(true);
                const p = window.gdsdk.showAd("rewarded");
                if (p && typeof p.then === "function") {
                    p.then((result) => {
                        setSdkAdActive(false);
                        if (result === true || result === "rewarded" || (result && result.status === "rewarded")) {
                            pendingRewardResolve && pendingRewardResolve();
                        } else {
                            pendingRewardReject && pendingRewardReject();
                        }
                    }).catch(() => {
                        setSdkAdActive(false);
                        pendingRewardReject && pendingRewardReject();
                    });
                } else {
                    setSdkAdActive(false);
                    pendingRewardResolve && pendingRewardResolve();
                }
            } else {
                pendingRewardReject && pendingRewardReject();
            }
        } catch (err) {
            setSdkAdActive(false);
            pendingRewardReject && pendingRewardReject();
        }
        return;
    }

    pendingRewardReject && pendingRewardReject();
}

function cycleSdkMode() {
    const index = SDK_MODES.indexOf(activeSdk);
    const next = SDK_MODES[(index + 1) % SDK_MODES.length];
    localStorage.setItem("pixelActiveSdk", next);
    activeSdk = next;
    alert("SDK mode: " + next + " (page will reload)");
    location.reload();
}

/* ================= CHARACTERS (Original Colors/Prices) ================= */
const characters = [
    { name: "Soldier", color: "cyan", price: 0 },
    { name: "Red Force", color: "red", price: 600 },
    { name: "Green Hero", color: "lime", price: 1200 },
    { name: "Shadow Ops", color: "orange", price: 2400 },
    { name: "Cyber X", color: "magenta", price: 4800 }
];

/* ================= PLAYER ================= */
const player = {
    x: 100,
    y: GROUND_Y - 75,
    w: 55,
    h: 75,
    dx: 0,
    dy: 0,
    speed: 5,
    jump: 12,
    onGround: false,
    facing: 1,

    maxHealth: 100,
    health: 100,
    invincible: 0
};
/* ================= INPUT ================= */
addEventListener("keydown", e => {
    keys[e.key] = true;
    ensureAudio();
    if (e.key === "F8") {
        cycleSdkMode();
        return;
    }

    if (gameState === "play" && e.key === "f") {
        shoot();
    }

    if (e.key === "Escape") {

        if (gameState === "play") {
            pauseGame();
            return;
        }

        if (gameState === "pause") {
            resumeGame();
            return;
        }

        if (gameState === "shop" || gameState === "levels") {
            goHome();
            return;
        }
    }


    if (gameState === "home") {
        if (e.key === "ArrowDown") menuIndex = (menuIndex + 1) % 3;
        if (e.key === "ArrowUp") menuIndex = (menuIndex + 2) % 3;
        if (e.key === "Enter") {
            handleMenu();
            return;
        }
    }
    if (gameState === "levels") {
        if (e.key === "ArrowLeft" && selectedStage > 1) {
            selectedStage--;
            selectedLevel = getDefaultLevelForStage(selectedStage);
        }
        if (e.key === "ArrowRight" && selectedStage < TOTAL_STAGES) {
            selectedStage++;
            selectedLevel = getDefaultLevelForStage(selectedStage);
        }
        if (e.key === "Enter") startLevel(selectedLevel);
    }

});

addEventListener("keyup", e => keys[e.key] = false);


function pauseGame() {
    if (gameState !== "play") return;

    gameState = "pause";
    if (window.PLATFORM_SDK === "crazygames" && window.CrazyGames?.SDK?.game) {
        window.CrazyGames.SDK.game.gameplayStop();
    }
}

function resumeGame() {
    if (gameState !== "pause") return;

    gameState = "play";
    if (window.PLATFORM_SDK === "crazygames" && window.CrazyGames?.SDK?.game) {
        window.CrazyGames.SDK.game.gameplayStart();
    }
}

function goHome() {
    gameState = "home";
}

function backFromShop() {
    gameState = "home";
}

function backFromLevels() {
    gameState = "home";
}


function handleMenu() {
    if (menuIndex === 0) startLevel(save.unlockedLevel);
    if (menuIndex === 1) {
        selectedStage = getStageFromLevel(save.unlockedLevel);
        selectedLevel = getDefaultLevelForStage(selectedStage);
        gameState = "levels";
    }
    if (menuIndex === 2) gameState = "shop";
}

function getStageFromLevel(level) {
    return Math.max(1, Math.min(TOTAL_STAGES, Math.ceil(level / LEVELS_PER_STAGE)));
}

function getLevelInStage(level) {
    return ((level - 1) % LEVELS_PER_STAGE) + 1;
}

function getDefaultLevelForStage(stage) {
    const stageStart = (stage - 1) * LEVELS_PER_STAGE + 1;
    const stageEnd = stage * LEVELS_PER_STAGE;
    if (save.unlockedLevel < stageStart) return stageStart;
    return Math.min(stageEnd, save.unlockedLevel);
}

/* ================= LEVEL LOGIC ================= */
function startLevel(id) {
    currentLevel = Math.max(1, Math.min(id, TOTAL_LEVELS));
    selectedStage = getStageFromLevel(currentLevel);
    selectedLevel = currentLevel;
    resetPlayer();
    spawnEnemies();
    bullets = [];
    enemyBullets = [];
    boss = null;
    bossSpawned = false;
    adClaimedOnWin = false;
    lastCheckpoint = { x: player.x, y: player.y };
    gameState = "play";

    if (window.PLATFORM_SDK === "crazygames" && window.CrazyGames?.SDK?.game) {
        window.CrazyGames.SDK.game.gameplayStart();
    }
}

function resetPlayer() {
    player.x = 100;
    player.y = GROUND_Y - player.h;
    player.dx = 0;
    player.dy = 0;
    player.facing = 1;

    player.health = player.maxHealth;
    player.invincible = 60;
}

function spawnEnemies() {
    enemies = [];
    const stage = getStageFromLevel(currentLevel);
    const stageLevel = getLevelInStage(currentLevel);
    const enemyCount = Math.min(4 + stage + Math.floor(stageLevel / 2), 16);

    for (let i = 0; i < enemyCount; i++) {
        const spread = (LEVEL_WIDTH - 900) / enemyCount;
        const spawnX = 500 + i * spread + Math.random() * 100;
        enemies.push({
            x: spawnX,
            y: GROUND_Y - 75,
            w: 55,
            h: 75,
            speed: 1.8 + stage * 0.08,
            range: 120 + stageLevel * 6,
            startX: spawnX,
            facing: -1,
            shootCooldown: 70 + Math.random() * 90
        });
    }
}

function spawnBoss() {
    boss = {
        x: LEVEL_WIDTH - 320,
        y: GROUND_Y - 100,
        w: 90,
        h: 100,
        speed: 2.2,
        range: 180,
        startX: LEVEL_WIDTH - 320,
        facing: -1,
        maxHealth: 450,
        health: 450,
        shootCooldown: 40
    };
    bossSpawned = true;
}

/* ================= UPDATE ================= */
function update() {
    if (player.invincible > 0) {
        player.invincible--;
    }
    if (gameState !== "play") return;

    // Movement
    if (keys.ArrowRight) {
        player.dx = player.speed;
        player.facing = 1;
    } else if (keys.ArrowLeft) {
        player.dx = -player.speed;
        player.facing = -1;
    }
    else player.dx = 0;

    if ((keys[" "] || keys.ArrowUp) && player.onGround) {
        player.dy = -player.jump;
        player.onGround = false;
        playJumpSound();
    }
    // ===== MOBILE CONTROLS =====
    if (isMobile()) {

        if (touchLeft) {
            player.dx = -player.speed;
            player.facing = -1;
        }

        if (touchRight) {
            player.dx = player.speed;
            player.facing = 1;
        }

        if (touchJump && player.onGround) {
            player.dy = -player.jump;
            player.onGround = false;
            playJumpSound();
            touchJump = false;
        }

        if (touchShoot) {
            shoot();
            touchShoot = false;
        }
    }

    player.dy += GRAVITY;
    player.x += player.dx;
    player.y += player.dy;

    // Ground Collision
    if (player.y + player.h > GROUND_Y) {
        player.y = GROUND_Y - player.h;
        player.dy = 0;
        player.onGround = true;
    }

    // Save revive checkpoint during active gameplay.
    lastCheckpoint.x = player.x;
    lastCheckpoint.y = player.y;

    // Level Boundaries
    if (player.x < 0) player.x = 0;
    if (player.x > LEVEL_WIDTH - player.w) player.x = LEVEL_WIDTH - player.w;

    // Enemy Patrol & Hit Detection
    enemies.forEach(en => {
        en.x += en.speed;
        if (Math.abs(en.x - en.startX) > en.range) en.speed *= -1;
        en.facing = player.x >= en.x ? 1 : -1;

        // Collision Check
        if (player.x < en.x + en.w && player.x + player.w > en.x &&
            player.y < en.y + en.h && player.y + player.h > en.y) {
            damagePlayer(25);
        }
        // Enemy Shooting
        en.shootCooldown--;

        if (en.shootCooldown <= 0) {
            const dir = en.facing;

            enemyBullets.push({
                x: dir === 1 ? en.x + en.w : en.x - 8,
                y: en.y + 25,
                speed: 6 * dir,
                w: 12,
                h: 5
            });
            playEnemyShootSound();

            en.shootCooldown = 120 + Math.random() * 100;
        }
    });

    // Every level has an end boss.
    if (!bossSpawned && player.x > LEVEL_WIDTH - 800) {
        spawnBoss();
    }

    if (boss) {
        boss.x += boss.speed;
        if (Math.abs(boss.x - boss.startX) > boss.range) boss.speed *= -1;
        boss.facing = player.x >= boss.x ? 1 : -1;

        if (player.x < boss.x + boss.w && player.x + player.w > boss.x &&
            player.y < boss.y + boss.h && player.y + player.h > boss.y) {
            damagePlayer(35);
        }

        boss.shootCooldown--;
        if (boss.shootCooldown <= 0) {
            const dir = boss.facing;
            enemyBullets.push({
                x: dir === 1 ? boss.x + boss.w : boss.x - 10,
                y: boss.y + 40,
                speed: 8 * dir,
                w: 14,
                h: 6
            });
            enemyBullets.push({
                x: dir === 1 ? boss.x + boss.w : boss.x - 10,
                y: boss.y + 52,
                speed: 7 * dir,
                w: 14,
                h: 6
            });
            playEnemyShootSound();
            boss.shootCooldown = 70 + Math.random() * 35;
        }
    }

    // Bullet movement
    bullets.forEach((b, bIndex) => {

        b.x += b.speed;

        // Remove bullet if off screen
        if (b.x > LEVEL_WIDTH + 20 || b.x < -20) {
            bullets.splice(bIndex, 1);
            return;
        }

        // Bullet vs Enemy
        enemies.forEach((en, eIndex) => {

            if (b.x < en.x + en.w &&
                b.x + b.w > en.x &&
                b.y < en.y + en.h &&
                b.y + b.h > en.y) {

                // Remove enemy
                enemies.splice(eIndex, 1);

                // Remove bullet
                bullets.splice(bIndex, 1);

                // Give coin reward
                save.coins += 20;
                saveGame();
                playHitSound();
            }

        });

        // Bullet vs Boss
        if (boss &&
            b.x < boss.x + boss.w &&
            b.x + b.w > boss.x &&
            b.y < boss.y + boss.h &&
            b.y + b.h > boss.y) {
            bullets.splice(bIndex, 1);
            boss.health -= 12;

            if (boss.health <= 0) {
                boss = null;
                save.coins += 200;
                saveGame();
                playHitSound();
            }
        }

    });

    // Enemy bullet movement
    enemyBullets.forEach((b, index) => {

        b.x += b.speed;

        // Remove if off map
        if (b.x < -20 || b.x > LEVEL_WIDTH + 20) {
            enemyBullets.splice(index, 1);
            return;
        }

        // Collision with player
        if (b.x < player.x + player.w &&
            b.x + b.w > player.x &&
            b.y < player.y + player.h &&
            b.y + b.h > player.y) {

            damagePlayer(20);
            enemyBullets.splice(index, 1);
        }

    });

    // Win Condition
    if (bossSpawned && !boss && player.x > LEVEL_WIDTH - 100) levelComplete();
}

function levelComplete() {
    gameState = "win";
    save.coins += WIN_BASE_REWARD;
    if (save.unlockedLevel === currentLevel && save.unlockedLevel < TOTAL_LEVELS) save.unlockedLevel++;
    saveGame();
    adClaimedOnWin = false;
    playWinSound();

    if (window.PLATFORM_SDK === "crazygames" && window.CrazyGames?.SDK?.game) {
        window.CrazyGames.SDK.game.gameplayStop();
    }
}

/* ================= DRAWING ================= */
function draw() {
    ctx.clearRect(0, 0, 960, 540);

    if (gameState === "home") drawHome();
    if (gameState === "levels") drawLevelsScreen();
    if (gameState === "shop") drawShop();
    if (gameState === "play" || gameState === "win" || gameState === "gameOver") drawGame();
    if (gameState === "pause") {
        drawGame();
        drawPausePopup();
    }
    if (gameState === "win") drawWinPopup();
    if (gameState === "gameOver") drawGameOverPopup();
    drawAudioButton();
}

function drawAudioButton() {
    const x = AUDIO_BTN.x;
    const y = AUDIO_BTN.y;
    const w = AUDIO_BTN.w;
    const h = AUDIO_BTN.h;

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "white";
    ctx.strokeRect(x, y, w, h);

    // Speaker body
    ctx.fillStyle = isMuted ? "#9a9a9a" : "#ffffff";
    ctx.fillRect(x + 8, y + 12, 8, 8);
    ctx.beginPath();
    ctx.moveTo(x + 16, y + 12);
    ctx.lineTo(x + 23, y + 8);
    ctx.lineTo(x + 23, y + 24);
    ctx.lineTo(x + 16, y + 20);
    ctx.closePath();
    ctx.fill();

    if (isMuted) {
        ctx.strokeStyle = "#ff4d4d";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 26, y + 10);
        ctx.lineTo(x + 35, y + 22);
        ctx.stroke();
        ctx.lineWidth = 1;
    } else {
        ctx.strokeStyle = "#8fffa0";
        ctx.beginPath();
        ctx.arc(x + 25, y + 16, 4, -0.7, 0.7);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x + 25, y + 16, 7, -0.7, 0.7);
        ctx.stroke();
    }

    const shortName = activeSdk === "none" ? "OFF" :
        activeSdk === "crazygames" ? "CG" :
            activeSdk === "gamemonetize" ? "GM" : "GD";
    ctx.fillStyle = "#d0d0d0";
    ctx.font = "10px Arial";
    ctx.textAlign = "center";
    ctx.fillText(shortName, x + w / 2, y + h + 10);
}

function isInAudioButton(px, py) {
    return px >= AUDIO_BTN.x && px <= AUDIO_BTN.x + AUDIO_BTN.w &&
        py >= AUDIO_BTN.y && py <= AUDIO_BTN.y + AUDIO_BTN.h;
}

function drawGame() {
    ctx.save();

    // CAMERA SYSTEM: Centers on player
    let camX = -player.x + canvas.width / 2;
    if (camX > 0) camX = 0;
    if (camX < -(LEVEL_WIDTH - canvas.width)) camX = -(LEVEL_WIDTH - canvas.width);

    ctx.translate(camX, 0);

    // Tiled Background
    const stageBg = getBackgroundForStage(getStageFromLevel(currentLevel));
    if (stageBg) {
        for (let i = 0; i < 4; i++) {
            ctx.drawImage(stageBg, i * 960, 0, 960, 540);
        }
    }

    // Ground
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(0, GROUND_Y, LEVEL_WIDTH, 120);

    // Finish Line
    ctx.fillStyle = "gold";
    ctx.fillRect(LEVEL_WIDTH - 60, 320, 20, 100);

    // Enemies
    enemies.forEach(en => {
        drawEnemy(en.x, en.y, en.facing);
    });

    if (boss) drawBoss();


    // Player
    drawPlayer(player.x, player.y, player.facing);
    // Draw Bullets
    bullets.forEach(b => {
        drawPlayerBullet(b.x, b.y, b.w, b.h);
    });

    // Draw Enemy Bullets
    enemyBullets.forEach(b => {
        drawEnemyBullet(b.x, b.y, b.w, b.h);
    });

    ctx.restore();

    // UI
    ctx.fillStyle = "white";
    ctx.font = "18px Arial";
    // Health Bar
    ctx.fillStyle = "red";
    ctx.fillRect(20, 40, 200, 15);

    ctx.fillStyle = "lime";
    ctx.fillRect(20, 40, (player.health / player.maxHealth) * 200, 15);

    ctx.strokeStyle = "white";
    ctx.strokeRect(20, 40, 200, 15);

    // Info
    ctx.fillStyle = "white";
    ctx.fillText("Stage " + getStageFromLevel(currentLevel) + " - Level " + getLevelInStage(currentLevel) + " | Coins: " + save.coins, 20, 25);

    // ===== PAUSE BUTTON (TOP CENTER) =====
    const pauseBtn = {
        x: canvas.width / 2 - 20,
        y: 18,
        w: 40,
        h: 32
    };

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(pauseBtn.x, pauseBtn.y, pauseBtn.w, pauseBtn.h);

    ctx.fillStyle = "#fff";
    ctx.font = "20px Arial";
    ctx.textAlign = "center";
    ctx.fillText("⏸", pauseBtn.x + 20, pauseBtn.y + 23);

    window.pauseBtn = pauseBtn;

    // ===== MOBILE CONTROLS =====
    if (isMobile()) {

        const btnSize = 60;
        const margin = 20;
        const y = canvas.height - btnSize - margin;

        // Left Button
        mobileLeftBtn = {
            x: margin,
            y: y,
            w: btnSize,
            h: btnSize
        };

        // Right Button
        mobileRightBtn = {
            x: margin + btnSize + 15,
            y: y,
            w: btnSize,
            h: btnSize
        };

        // Jump Button
        mobileJumpBtn = {
            x: canvas.width - btnSize * 2 - margin * 2,
            y: y,
            w: btnSize,
            h: btnSize
        };

        // Shoot Button
        mobileShootBtn = {
            x: canvas.width - btnSize - margin,
            y: y,
            w: btnSize,
            h: btnSize
        };

        drawMobileBtn(mobileLeftBtn, "◀");
        drawMobileBtn(mobileRightBtn, "▶");
        drawMobileBtn(mobileJumpBtn, "⬆");
        drawMobileBtn(mobileShootBtn, "🔥");
    }

    if (bossSpawned) {
        ctx.fillText("Boss Fight", 120, 80);
        if (boss) {
            ctx.fillStyle = "#5a0000";
            ctx.fillRect(20, 95, 260, 12);
            ctx.fillStyle = "#ff2a2a";
            ctx.fillRect(20, 95, (boss.health / boss.maxHealth) * 260, 12);
            ctx.strokeStyle = "white";
            ctx.strokeRect(20, 95, 260, 12);
        }
    }
}

function drawEnemy(x, y, facing) {
    ctx.save();
    if (facing === 1) {
        ctx.translate(x + 55, 0);
        ctx.scale(-1, 1);
        x = 0;
    }

    const t = performance.now() * 0.01;
    const step = Math.sin(t + x * 0.05) * 1.2;

    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(x + 28, y + 82, 20, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Back arm
    ctx.fillStyle = "#7a5542";
    ctx.fillRect(x + 10, y + 33, 7, 22);

    // Torso armor
    const torsoGrad = ctx.createLinearGradient(x + 10, y + 25, x + 45, y + 60);
    torsoGrad.addColorStop(0, "#8a1313");
    torsoGrad.addColorStop(1, "#4a0707");
    ctx.fillStyle = torsoGrad;
    ctx.fillRect(x + 12, y + 24, 32, 36);

    // Tactical plates
    ctx.fillStyle = "#6a0b0b";
    ctx.fillRect(x + 18, y + 30, 20, 10);
    ctx.fillRect(x + 18, y + 44, 20, 12);
    ctx.fillStyle = "#301212";
    ctx.fillRect(x + 26, y + 30, 3, 26);

    // Neck
    ctx.fillStyle = "#d4a083";
    ctx.fillRect(x + 24, y + 20, 8, 6);

    // Head
    ctx.fillStyle = "#e0b090";
    ctx.beginPath();
    ctx.arc(x + 28, y + 15, 10, 0, Math.PI * 2);
    ctx.fill();

    // Helmet + visor
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(x + 16, y + 5, 24, 9);
    ctx.fillStyle = "#7f0e0e";
    ctx.fillRect(x + 18, y + 12, 20, 4);

    // Front arm + glove
    ctx.fillStyle = "#8f654c";
    ctx.fillRect(x + 38, y + 34, 7, 18);
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(x + 39, y + 50, 6, 5);

    // Rifle
    ctx.fillStyle = "#131313";
    ctx.fillRect(x - 17, y + 37, 28, 6);
    ctx.fillRect(x - 24, y + 39, 7, 3);
    ctx.fillStyle = "#3f3f3f";
    ctx.fillRect(x - 4, y + 39, 8, 2);

    // Legs + knee pads
    ctx.fillStyle = "#2f1a1a";
    ctx.fillRect(x + 16, y + 60 + step, 10, 15);
    ctx.fillRect(x + 32, y + 60 - step, 10, 15);
    ctx.fillStyle = "#190d0d";
    ctx.fillRect(x + 17, y + 66 + step, 8, 4);
    ctx.fillRect(x + 33, y + 66 - step, 8, 4);

    // Boots
    ctx.fillStyle = "#111";
    ctx.fillRect(x + 15, y + 75 + step, 12, 4);
    ctx.fillRect(x + 31, y + 75 - step, 12, 4);
    ctx.restore();
}

function drawPlayer(x, y, facing) {
    ctx.save();
    if (facing === -1) {
        ctx.translate(x + player.w, 0);
        ctx.scale(-1, 1);
        x = 0;
    }

    const t = performance.now() * 0.01;
    const step = Math.sin(t + x * 0.05) * 1.2;

    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(x + 28, y + player.h + 6, 20, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Back arm
    ctx.fillStyle = "#b58767";
    ctx.fillRect(x + 10, y + 33, 7, 22);

    // Body armor with metallic shading
    const armorColor = characters[save.selectedChar].color;
    const armorGrad = ctx.createLinearGradient(x + 12, y + 24, x + 44, y + 60);
    armorGrad.addColorStop(0, armorColor);
    armorGrad.addColorStop(1, "#1f2a33");
    ctx.fillStyle = armorGrad;
    ctx.fillRect(x + 12, y + 24, 32, 36);

    // Vest straps and chest rig
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(x + 16, y + 24, 4, 36);
    ctx.fillRect(x + 36, y + 24, 4, 36);
    ctx.fillStyle = "#2a3238";
    ctx.fillRect(x + 20, y + 32, 16, 10);
    ctx.fillRect(x + 20, y + 45, 16, 12);

    // Neck + Head
    ctx.fillStyle = "#e6b895";
    ctx.fillRect(x + 24, y + 20, 8, 6);
    ctx.fillStyle = "#ffddb8";
    ctx.beginPath();
    ctx.arc(x + 28, y + 15, 10, 0, Math.PI * 2);
    ctx.fill();

    // Helmet + visor glow
    ctx.fillStyle = "#1e2228";
    ctx.fillRect(x + 16, y + 5, 24, 9);
    ctx.fillStyle = "#5bc7ff";
    ctx.fillRect(x + 18, y + 12, 20, 4);

    // Front arm + glove
    ctx.fillStyle = "#b98b6d";
    ctx.fillRect(x + 38, y + 34, 7, 18);
    ctx.fillStyle = "#232a30";
    ctx.fillRect(x + 39, y + 50, 6, 5);

    // Rifle with small details
    ctx.fillStyle = "#111";
    ctx.fillRect(x + 42, y + 35, 22, 6);
    ctx.fillRect(x + 58, y + 37, 8, 3);
    ctx.fillStyle = "#3f3f3f";
    ctx.fillRect(x + 47, y + 37, 7, 2);

    // Backpack
    ctx.fillStyle = "#30363d";
    ctx.fillRect(x + 6, y + 28, 9, 27);

    // Legs + knee pads
    ctx.fillStyle = "#222a30";
    ctx.fillRect(x + 16, y + 60 + step, 10, 15);
    ctx.fillRect(x + 32, y + 60 - step, 10, 15);
    ctx.fillStyle = "#11171c";
    ctx.fillRect(x + 17, y + 66 + step, 8, 4);
    ctx.fillRect(x + 33, y + 66 - step, 8, 4);

    // Boots
    ctx.fillStyle = "#0b0f12";
    ctx.fillRect(x + 15, y + 75 + step, 12, 4);
    ctx.fillRect(x + 31, y + 75 - step, 12, 4);
    ctx.restore();
}

function drawBoss() {
    if (!boss) return;

    let x = boss.x;
    let y = boss.y;

    ctx.save();
    if (boss.facing === 1) {
        ctx.translate(x + boss.w, 0);
        ctx.scale(-1, 1);
        x = 0;
    }

    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(x + 15, y + boss.h + 2, 60, 8);

    ctx.fillStyle = "#7a3b00";
    ctx.fillRect(x + 22, y + 24, 46, 48);

    ctx.fillStyle = "#e0b090";
    ctx.beginPath();
    ctx.arc(x + 45, y + 16, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(x + 28, y + 4, 34, 10);

    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(x - 16, y + 40, 30, 8);
    ctx.fillRect(x - 24, y + 42, 8, 4);

    ctx.fillStyle = "#4a1d00";
    ctx.fillRect(x + 26, y + 75, 14, 22);
    ctx.fillRect(x + 52, y + 75, 14, 22);
    ctx.restore();
}

/* ================= MENU SCREENS (Keeping your styles) ================= */
function drawHome() {
    drawStaticBackground(getStageFromLevel(save.unlockedLevel));
    drawText("PIXEL COMMANDO", 480, 140, 64, "#FFD700");
    menu.forEach((m, i) => {
        let color = (i === menuIndex) ? "#FFD700" : "#ffffff";
        drawText((i === menuIndex ? "▶ " : "") + m, 480, 260 + i * 60, 34, color);
    });
    drawText("Coins: " + save.coins, 80, 40, 18, "white");
}

function drawLevels() {
    drawStaticBackground(selectedStage);
    drawText("LEVEL SELECT", 480, 120, 50, "#FFD700");
    for (let i = 1; i <= 10; i++) {
        let row = Math.floor((i - 1) / 5);
        let col = (i - 1) % 5;
        let x = 260 + col * 120;
        let y = 220 + row * 100;
        ctx.strokeStyle = "white";
        ctx.strokeRect(x, y, 80, 60);
        drawText(i <= save.unlockedLevel ? i : "🔒", x + 40, y + 40, 24, "white");
    }
}

function drawLevelsScreen() {
    drawStaticBackground(selectedStage);
    drawText("LEVEL SELECT", 480, 120, 50, "#FFD700");
    drawText("STAGE " + selectedStage + " / " + TOTAL_STAGES, 480, 175, 28, "white");
    drawText("<", 95, 175, 42, selectedStage > 1 ? "#FFD700" : "gray");
    drawText(">", 865, 175, 42, selectedStage < TOTAL_STAGES ? "#FFD700" : "gray");

    for (let i = 1; i <= LEVELS_PER_STAGE; i++) {
        let row = Math.floor((i - 1) / 5);
        let col = (i - 1) % 5;
        let x = 260 + col * 120;
        let y = 220 + row * 100;
        let absoluteLevel = (selectedStage - 1) * LEVELS_PER_STAGE + i;
        let unlocked = absoluteLevel <= save.unlockedLevel;
        let selected = absoluteLevel === selectedLevel;
        ctx.strokeStyle = selected ? "#FFD700" : "white";
        ctx.lineWidth = selected ? 3 : 1;
        ctx.strokeRect(x, y, 80, 60);
        ctx.lineWidth = 1;
        drawText(unlocked ? i : "🔒", x + 40, y + 40, 20, "white");
    }
    drawText("Click once to select, ENTER to play", 480, 470, 18, "#dddddd");
}

function drawShopAvatar(x, y, armorColor) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(0.95, 0.95);

    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(28, 82, 18, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#b58767";
    ctx.fillRect(10, 33, 7, 22);

    const armorGrad = ctx.createLinearGradient(12, 24, 44, 60);
    armorGrad.addColorStop(0, armorColor);
    armorGrad.addColorStop(1, "#1f2a33");
    ctx.fillStyle = armorGrad;
    ctx.fillRect(12, 24, 32, 36);

    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(16, 24, 4, 36);
    ctx.fillRect(36, 24, 4, 36);
    ctx.fillStyle = "#2a3238";
    ctx.fillRect(20, 32, 16, 10);
    ctx.fillRect(20, 45, 16, 12);

    ctx.fillStyle = "#e6b895";
    ctx.fillRect(24, 20, 8, 6);
    ctx.fillStyle = "#ffddb8";
    ctx.beginPath();
    ctx.arc(28, 15, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1e2228";
    ctx.fillRect(16, 5, 24, 9);
    ctx.fillStyle = "#5bc7ff";
    ctx.fillRect(18, 12, 20, 4);

    ctx.fillStyle = "#b98b6d";
    ctx.fillRect(38, 34, 7, 18);
    ctx.fillStyle = "#232a30";
    ctx.fillRect(39, 50, 6, 5);

    ctx.fillStyle = "#111";
    ctx.fillRect(42, 35, 22, 6);
    ctx.fillRect(58, 37, 8, 3);

    ctx.fillStyle = "#30363d";
    ctx.fillRect(6, 28, 9, 27);

    ctx.fillStyle = "#222a30";
    ctx.fillRect(16, 60, 10, 15);
    ctx.fillRect(32, 60, 10, 15);
    ctx.fillStyle = "#0b0f12";
    ctx.fillRect(15, 75, 12, 4);
    ctx.fillRect(31, 75, 12, 4);
    ctx.restore();
}

function drawShop() {
    drawStaticBackground(getStageFromLevel(save.unlockedLevel));
    drawText("SHOP", 480, 100, 50, "#FFD700");

    characters.forEach((c, i) => {
        let x = 150 + i * 160;
        let y = 215;
        const unlocked = save.unlockedChars[i];
        const selected = i === save.selectedChar;

        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(x, y, 120, 185);

        ctx.strokeStyle = selected ? "#FFD700" : "white";
        ctx.lineWidth = selected ? 3 : 2;
        ctx.strokeRect(x, y, 120, 185);
        ctx.lineWidth = 1;

        drawShopAvatar(x + 30, y + 18, c.color);
        drawText(c.name, x + 60, y + 118, 14, "white");

        if (selected) {
            drawText("EQUIPPED", x + 60, y + 145, 14, "#FFD700");
        } else if (unlocked) {
            drawText("OWNED", x + 60, y + 145, 14, "#7CFC00");
        } else {
            drawText("BUY " + c.price + " C", x + 60, y + 145, 14, "#ffb347");
        }

        drawText("Select", x + 60, y + 168, 12, "#cfcfcf");
    });
    drawText("Coins: " + save.coins, 480, 460, 20, "white");
}

function drawPopupFrame(title, subText) {
    ctx.fillStyle = "rgba(0,0,0,0.58)";
    ctx.fillRect(0, 0, 960, 540);
    ctx.fillStyle = "rgba(18,18,18,0.95)";
    ctx.fillRect(220, 120, 520, 300);
    ctx.strokeStyle = "#FFD700";
    ctx.lineWidth = 3;
    ctx.strokeRect(220, 120, 520, 300);
    ctx.lineWidth = 1;
    drawText(title, 480, 180, 42, "#FFD700");
    drawText(subText, 480, 225, 22, "white");
}

function drawPopupButton(x, y, w, h, text, color = "#2a2a2a") {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "white";
    ctx.strokeRect(x, y, w, h);
    drawText(text, x + w / 2, y + 30, 18, "white");
}

function drawGameOverPopup() {
    drawPopupFrame("GAME OVER", "Try again or watch ad to revive");
    drawPopupButton(265, 280, 130, 44, "RETRY", "#6a1f1f");
    drawPopupButton(415, 280, 130, 44, "WATCH AD", "#1f4f1f");
    drawPopupButton(565, 280, 130, 44, "HOME", "#1f2f6a");
    drawText("Revive from where you died", 480, 355, 16, "#d8d8d8");
}

function drawWinPopup() {
    drawPopupFrame("LEVEL COMPLETE!", "+" + WIN_BASE_REWARD + " coins earned");
    drawPopupButton(245, 280, 140, 44, "NEXT LEVEL", "#1f4f1f");
    drawPopupButton(410, 280, 140, 44, "WATCH AD", adClaimedOnWin ? "#444" : "#695400");
    drawPopupButton(575, 280, 140, 44, "HOME", "#1f2f6a");
    drawText(adClaimedOnWin ? "2X reward already claimed" : "Watch ad for extra +" + WIN_BASE_REWARD + " coins (2X)", 480, 355, 16, "#d8d8d8");
}

function inRect(px, py, x, y, w, h) {
    return px >= x && px <= x + w && py >= y && py <= y + h;
}

function handleGameOverClick(x, y) {
    if (inRect(x, y, 265, 280, 130, 44)) {
        startLevel(currentLevel);
        return true;
    }
    if (inRect(x, y, 415, 280, 130, 44)) {
        requestRewardedAd(() => {
            player.x = Math.max(0, Math.min(lastCheckpoint.x, LEVEL_WIDTH - player.w));
            player.y = lastCheckpoint.y;
            player.dx = 0;
            player.dy = 0;
            player.health = Math.max(45, Math.floor(player.maxHealth * 0.5));
            player.invincible = 90;
            gameState = "play";
        });
        return true;
    }
    if (inRect(x, y, 565, 280, 130, 44)) {
        gameState = "home";
        resetPlayer();
        return true;
    }
    return false;
}

function handleWinClick(x, y) {
    if (inRect(x, y, 245, 280, 140, 44)) {
        if (currentLevel < TOTAL_LEVELS) startLevel(currentLevel + 1);
        else gameState = "home";
        return true;
    }
    if (inRect(x, y, 410, 280, 140, 44)) {
        if (!adClaimedOnWin) requestRewardedAd(() => {
            save.coins += WIN_BASE_REWARD;
            adClaimedOnWin = true;
            saveGame();
        });
        return true;
    }
    if (inRect(x, y, 575, 280, 140, 44)) {
        gameState = "home";
        return true;
    }
    return false;
}

function getBackgroundForStage(stage) {
    const index = Math.max(1, Math.min(stage, stageBackgrounds.length)) - 1;
    const img = stageBackgrounds[index];
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    return img;
}

function drawStaticBackground(stage = 1) {
    const bg = getBackgroundForStage(stage);
    if (bg) ctx.drawImage(bg, 0, 0, 960, 540);
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(0, 0, 960, 540);
}

function drawText(text, x, y, size, color) {
    ctx.font = "bold " + size + "px Arial";
    ctx.textAlign = "center";
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
}

function damagePlayer(amount) {

    if (player.invincible > 0) return;

    player.health -= amount;
    player.invincible = 40;
    playHitSound();

    if (player.health <= 0) {
        gameState = "gameOver";

        if (window.PLATFORM_SDK === "crazygames" && window.CrazyGames?.SDK?.game) {
            window.CrazyGames.SDK.game.gameplayStop();
        }
    }
}

function shoot() {
    const dir = player.facing;

    bullets.push({
        x: dir === 1 ? player.x + player.w : player.x - 10,
        y: player.y + 28,
        speed: 8 * dir,
        w: 14,
        h: 6
    });
    playShootSound();

}

function drawPlayerBullet(x, y, w, h) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 4;
    ctx.fillStyle = "#0d1b24";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#27d6ff";
    ctx.fillRect(x + 2, y + 1, Math.max(2, w - 4), Math.max(2, h - 2));
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
}

function drawEnemyBullet(x, y, w, h) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 4;
    ctx.fillStyle = "#260909";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#ff5a4a";
    ctx.fillRect(x + 2, y + 1, Math.max(2, w - 4), Math.max(2, h - 2));
    ctx.strokeStyle = "rgba(255,230,230,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
}

function getCanvasPointer(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY
    };
}

/* ================= CLICK LOGIC ================= */
canvas.addEventListener("click", e => {
    ensureAudio();
    const pointer = getCanvasPointer(e);
    const clickX = pointer.x;
    const clickY = pointer.y;

    handleCanvasClick(e);

    if (isInAudioButton(clickX, clickY)) {
        isMuted = !isMuted;
        applyAudioState();
        if (!isMuted) playTone(740, 0.05, "triangle", 0.04, 880);
        return;
    }

    if (
        gameState === "play" &&
        window.pauseBtn &&
        clickX >= pauseBtn.x &&
        clickX <= pauseBtn.x + pauseBtn.w &&
        clickY >= pauseBtn.y &&
        clickY <= pauseBtn.y + pauseBtn.h
    ) {
        pauseGame();
        return;
    }

    // ===== PAUSE MENU BUTTONS =====
    if (gameState === "pause") {

        // Resume
        if (inRect(clickX, clickY, 265, 280, 130, 44)) {
            resumeGame();
            return;
        }

        // Restart
        if (inRect(clickX, clickY, 415, 280, 130, 44)) {
            startLevel(currentLevel);
            return;
        }

        // Home
        if (inRect(clickX, clickY, 565, 280, 130, 44)) {
            goHome();
            return;
        }
    }

    if (gameState === "gameOver") {
        handleGameOverClick(clickX, clickY);
        return;
    }
    if (gameState === "win") {
        handleWinClick(clickX, clickY);
        return;
    }

    if (gameState === "levels") {
        if (clickX > 50 && clickX < 140 && clickY > 140 && clickY < 205 && selectedStage > 1) {
            selectedStage--;
            selectedLevel = getDefaultLevelForStage(selectedStage);
            return;
        }
        if (clickX > 820 && clickX < 910 && clickY > 140 && clickY < 205 && selectedStage < TOTAL_STAGES) {
            selectedStage++;
            selectedLevel = getDefaultLevelForStage(selectedStage);
            return;
        }

        for (let i = 1; i <= LEVELS_PER_STAGE; i++) {
            let row = Math.floor((i - 1) / 5);
            let col = (i - 1) % 5;
            let x = 260 + col * 120;
            let y = 220 + row * 100;
            let absoluteLevel = (selectedStage - 1) * LEVELS_PER_STAGE + i;
            if (clickX > x && clickX < x + 80 && clickY > y && clickY < y + 60) {
                if (absoluteLevel <= save.unlockedLevel) {
                    if (selectedLevel === absoluteLevel) {
                        startLevel(absoluteLevel);
                        return;
                    }
                    selectedLevel = absoluteLevel;
                }
                return;
            }
        }
        return;
    }

    if (gameState !== "shop") return;
    characters.forEach((c, i) => {
        let x = 150 + i * 160;
        let y = 215;
        if (clickX > x && clickX < x + 120 && clickY > y && clickY < y + 185) {
            if (save.unlockedChars[i]) {
                save.selectedChar = i;
            } else if (save.coins >= c.price) {
                save.coins -= c.price;
                save.unlockedChars[i] = true;
                save.selectedChar = i;
            }
            saveGame();
        }
    });
});

// ===== MOBILE TOUCH START =====
function handleCanvasClick(eOrX, maybeY) {

    // ===== TOUCH EVENT =====
    if (typeof eOrX === "object") {

        const e = eOrX;

        if (!isMobile()) return;

        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        for (let t of e.touches) {

            const x = (t.clientX - rect.left) * scaleX;
            const y = (t.clientY - rect.top) * scaleY;

            checkMobileButtons(x, y);
        }

        e.preventDefault();
        return;
    }

    // ===== NORMAL CLICK =====
    const x = eOrX;
    const y = maybeY;

    checkMobileButtons(x, y);
}

function checkMobileButtons(x, y) {

    if (!isMobile()) return;

    // LEFT
    if (mobileLeftBtn && inRect(x, y,
        mobileLeftBtn.x,
        mobileLeftBtn.y,
        mobileLeftBtn.w,
        mobileLeftBtn.h)) {

        touchLeft = true;
    }

    // RIGHT
    if (mobileRightBtn && inRect(x, y,
        mobileRightBtn.x,
        mobileRightBtn.y,
        mobileRightBtn.w,
        mobileRightBtn.h)) {

        touchRight = true;
    }

    // JUMP
    if (mobileJumpBtn && inRect(x, y,
        mobileJumpBtn.x,
        mobileJumpBtn.y,
        mobileJumpBtn.w,
        mobileJumpBtn.h)) {

        touchJump = true;
    }

    // SHOOT
    if (mobileShootBtn && inRect(x, y,
        mobileShootBtn.x,
        mobileShootBtn.y,
        mobileShootBtn.w,
        mobileShootBtn.h)) {

        touchShoot = true;
    }
}

canvas.addEventListener("touchend", function () {
    touchLeft = false;
    touchRight = false;
    touchJump = false;
    touchShoot = false;
});

function drawPausePopup() {
    drawPopupFrame("PAUSED", "Game is paused");

    drawPopupButton(265, 280, 130, 44, "RESUME", "#1f4f1f");
    drawPopupButton(415, 280, 130, 44, "RESTART", "#6a1f1f");
    drawPopupButton(565, 280, 130, 44, "HOME", "#1f2f6a");
}

function showMidgameAd() {
    if (activeSdk === "crazygames" && window.CrazyGames?.SDK?.ad) {
        const callbacks = {
            adStarted: () => {
                setSdkAdActive(true);
            },
            adFinished: () => {
                setSdkAdActive(false);
                pendingRewardResolve && pendingRewardResolve();
            },
            adError: () => {
                setSdkAdActive(false);
                pendingRewardReject && pendingRewardReject();
            }
        };
        window.CrazyGames.SDK.ad.requestAd("rewarded", callbacks);
        return;
    }
}



function isMobile() {
    return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(navigator.userAgent);
}

function drawMobileBtn(btn, text) {

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(btn.x, btn.y, btn.w, btn.h);

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(btn.x, btn.y, btn.w, btn.h);

    ctx.fillStyle = "#fff";
    ctx.font = "26px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.fillText(
        text,
        btn.x + btn.w / 2,
        btn.y + btn.h / 2
    );
}

// ===== TOUCH = CLICK FIX (MENU / SHOP / LEVELS) =====
canvas.addEventListener("touchstart", function (e) {

    if (!isMobile()) return;

    handleCanvasClick(e);

}, { passive: false });

function loop() {
    update();
    draw();
    requestAnimationFrame(loop);

}

setupSdk();
loop();
