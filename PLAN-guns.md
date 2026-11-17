# 坦克模拟器：火炮系统 + 摄像头瞄准镜 开发计划

> 给 Claude Code 的工作说明。项目在 `D:\GitHub\tank`，部署在 GitHub Pages（`https://neuer712.github.io/tank/`）。
> 用户（熊哥）是程序员，会自己在手机和电脑上试听并反馈。

---

## 0. 现有项目概况（必读）

### 文件
| 文件 | 作用 |
|---|---|
| `index.html` | 页面骨架（HTML），引用 `styles.css` 和 `app.js`，无构建步骤 |
| `styles.css` | 全部样式 |
| `app.js` | 全部逻辑：音频合成、物理、GPS、火炮架构、瞄准镜 |
| `sounds/*.wav` | 录音引擎（`engine_idle/high/start/stop.wav`）、录音履带 `track.wav`、地面 `ground.wav` |
| `sounds/halt/1-5.m4a`、`sounds/losfahren/1-5.m4a` | 用户自录的德语口令，随机播放 |
| `build_standalone.py` | 把 `index.html` + `app.js` + `styles.css` 合并成一个文件，并把 `sounds/` 下的音频以 Base64 Data URI 嵌入，生成 `tank-standalone.html`（双击即可测试，不需要服务器） |
| `_backup_recordings/`、`tank-standalone.html` | **不要提交到 git**（建议加进 `.gitignore`） |

> GitHub Pages 是纯静态托管，`index.html` 引用外部 `app.js`/`styles.css` 完全没问题——拆文件只是为了让 `index.html` 别无限变长，不影响线上效果。`build_standalone.py` 负责在生成单文件测试版时把它们重新内联回去。

### 音频架构（Web Audio API）
- `buildAudio()`：创建 `ctx`（AudioContext）→ `master`（GainNode，音量滑块）→ `comp`（DynamicsCompressor，threshold -14, ratio 4）→ destination。
- `noiseBuf`：2 秒白噪声 buffer，所有噪声类音效共用。
- `loadAudio(url)`：加载音频；先查 `EMBED[url]`（单文件版里的 Data URI），再 fetch。
- 工具函数：`noiseHit(time, dur, gain, filterType, freq, q)`、`thump(time, f0, f1, dur, gain)`、`shaperCurve(k)`、`clamp()`。
- `voiceBus` + `RADIO_FX`：口令的对讲机效果（350–3200 Hz 带通 + 失真）。
- 引擎：三套可切换（录音 / 经典 / 逐缸），各有独立 bus。

### 主循环
- `loop()` 每 50 ms：`physicsStep()` → 档位/转速/负载 → `updateAudio()` → `checkVoiceEvents()` → `motionStep()` → **`updateGuns()`（本次新增，见 §1）**。
- 行驶音效（引擎/履带/口令）由全局 `setInterval` 驱动，与界面显示的是哪个页面**无关**——进入瞄准镜界面不会停止这些定时器，驾驶声音和车长口令照常继续。

---

## 第一部分：火炮架构（已纠正方向，核心已实现）

### 1.0 为什么原计划的重点错了
之前的版本把“这辆车挂几门炮”当成设计的主线（见旧版 §1.1 的 7 行表格）。这是错的：**门数不重要，每一门炮本身的行为才是这个系统的核心**。一辆车挂一门炮还是两门炮，只是“用哪几个炮的实例拼一下”，不应该是架构的出发点。

正确的分层：

```
Gun（炮）──────────────────────────────────────────────
  最小状态/声音单位。每个实例独立拥有：
    · 口径 cal、射击方式 fireMode（单发 / 弹匣连发 burstMag / 全自动 auto）
    · 弹药/弹匣容量 magSize、射速 rpm（连发用）、夹内间隔 interShot（弹匣炮用）
    · 装填时间 reloadTime
    · 装填音效类型 reloadSound：
        - 'single'       单发炮：开闩 + 入膛闭锁 两段声
        - 'single_heavy' 大口径单发炮：同上但更低沉更长（如 128mm 分装弹）
        - 'magazine'     弹匣炮：多段“哗啦”声 + 到位声
        - 'magazine_heavy' 大口径弹匣炮：同上但段数更多、更沉
        - 'belt'         弹链机枪：不需要装填声（持续供弹）
    · 回转惯性 inertia：转动越慢的炮（大口径）数值越小，留给瞄准镜里
      “炮管跟随手机转动有多滞后”用（见 §2.3，尚未接入视觉）
    · 开炮效果 recoil = { shake, flash, kick }：震屏强度、炮口闪光强度、
      后坐行程，三者都随口径缩放

WeaponSystem（武器系统）──────────────────────────────
  玩家可选择的最小单位。由 1~2 个 Gun 实例组成（主炮 / 同轴 / 第二主炮），
  例如：
    · 双 57 自行高炮 = 两个独立的 57mm Gun 实例（role: main, main2）
    · 59 式          = 一个 100mm 主炮 Gun + 一个 7.62mm 同轴机枪 Gun
  同一武器系统里的每个 Gun 装填/弹药状态完全独立，互不影响。
```

这样同一种炮（比如 MG34）可以被虎式和 Sd.Kfz.222 两个武器系统复用，不用重复定义参数；调整某一类炮的手感只需要改一处 `GUNS` 表。

再往上还有一层：

```
Tank（坦克）──────────────────────────────────────────────
  玩家在底部坦克栏里选择的单位。只负责两件事：
    · 固定一套声音（engine 取值 'sample'/'classic'/'cyl'，track 取值 'rec'/'v1'）——
      玩家不能再单独切换引擎/履带声源，声音是这辆车的一部分
    · 绑定恰好一个 WeaponSystem（不同 Tank 允许指向同一个 WeaponSystem，
      架构上没问题，只是现在 7 辆车各用各的）
```

### 1.1 已实现：`GUNS` + `WEAPON_SYSTEMS` + `TANKS`（`app.js`）
`GUNS` 对象定义了 12 种炮（`kwk30` 20mm 机关炮、`mg34`、`d10t` 100mm、`coaxMg` 7.62mm、`kwk36` 88mm、`kwk44_128` 128mm、`kwk44_75` 75mm 同轴炮、`amx120` 120mm 弹夹炮、`frMg` 7.5mm、`flak57` 57mm 高炮、`m3_75` 75mm、`m1919` .30cal），每个都带齐上面列的全部字段。

`WEAPON_SYSTEMS` 对象把 7 个武器系统（`sdkfz222` / `type59` / `tiger` / `maus` / `amx50` / `twin57` / `sherman`）定义成「引用哪几个 `GUNS` 条目、各自的角色」，外加一个 `reticle` 字段（瞄准镜图样名字，见 §2.2）。

`TANKS` 对象定义了 7 辆坦克，每辆都指向 `WEAPON_SYSTEMS` 里的一个条目，并固定了 `engine`/`track` 这套声音组合（7 辆车用了 6 种声音组合中的 5 种，两辆重复了一组——引擎只有 3 种合成方式、履带只有 2 种，7 辆车不够一一对应，重复的是能接受的）。页面底部 `#tankNav` 按 `TANK_SLOTS` 顺序列出全部 7 辆（59 式、Sd.Kfz.222 在最前面），点一下 `selectTank(id)`：切声音 bus、退出瞄准镜、重建这辆车武器系统的炮状态。

### 1.2 已实现：开炮/装填的运行时逻辑
- `tryFireGun(role, now)`：检查该炮是否在装填 / 是否在夹内间隔冷却中 / 弹药是否耗尽，决定是否真正开火、是否立即进入装填、或进入夹内下一发冷却。
- `updateGuns(dt)`：每个 `loop()` tick（50ms）调用，推进每门炮的装填倒计时，装填完成后补满弹药。**这是全局循环的一部分，不依赖瞄准镜界面是否打开。**
- `fireShot(g)`：按口径 `cal` 缩放现有 `thump()` / `noiseHit()` 分层（小口径短促单发、全自动炮介于机枪和主炮之间、单发主炮用原 `boom()` 的分层思路），开炮后调用 `triggerRecoilFX()`。
- `playReloadSound(def)`：按 `reloadSound` 类型差异化合成装填声——单发是两段（开闩 / 闭锁），弹匣是多段哗啦声 + 到位声，弹链不发声。所有时长都对齐该炮自己的 `reloadTime`，不是固定数字。

### 1.3 尚未做（后续，不是本次范围）
- 录音优先的炮声/装填声资源位（`sounds/guns/<gunId>/...`，参考口令的随机轮换加载方式）仍是空的，目前全部是合成声音。
- §1.2 的新合成声音方案（冲击波尖峰 + 野外回声 ConvolverNode 等，旧计划 §1.4 的内容）还没做，`fireShot()` 目前只是对原 `boom()` 分层按口径做了缩放，听感上主炮和原来差别不大，机枪/机关炮是新写的。
- `inertia` 字段已经在 `GUNS` 里，但还没有任何视觉/手感消费它（见 §2.3）。

---

## 第二部分：摄像头瞄准镜

### 2.1 已实现（基础 DEMO）
- 入口是顶部角色栏的"炮手"图标（不再是驾驶页面里的按钮）：`setRole('gunner')` 直接调用 `enterScope()`。退出瞄准镜（`#scopeExit`）会把角色切回"整车"。
- `enterScope()`：显示全屏遮罩 `#scopeView`，调用 `getUserMedia({video:{facingMode:'environment'}})` 打开后置摄像头，画面接到 `<video>`；**不碰 `loopTimer` / `schedTimer` / `ctx`，驾驶时的引擎声、履带声、车长 Halt/Losfahren 口令继续播放**。
- 圆形取景：`.scope-circle` 用 `border-radius:50%; overflow:hidden` 裁剪 `<video>`，上面叠加同样圆形裁剪的 `<canvas>` 画通用十字瞄准刻度（`drawReticle()`）——目前所有武器系统共用一套简单刻度，不区分炮种风格。
- 开火按钮：`buildScopeButtons()` 按当前武器系统的 `guns` 列表动态生成按钮（主炮 / 同轴 / 炮2），`bindFireButton()` 处理 `pointerdown/up/leave/cancel`：单发/弹匣炮点一下开一炮，全自动炮按住连发（`setInterval` 按 `rpm` 调度），并阻止长按弹出系统菜单（`contextmenu`）。
- 开炮震动：`fireShot()` → `triggerRecoilFX()` 把 `recoil.shake` 累加到全局 `shakeAmp`，`scopeFrame()`（`requestAnimationFrame` 循环）里按衰减系数 0.86/帧 做随机位移 + 轻微旋转的震屏，叠加在 `.scope-stage` 的 CSS `transform` 上。
- 炮口闪光：`flashScope()` 把 `.scope-flash`（圆形径向渐变）的 `opacity` 瞬间拉高再做 CSS transition 淡出，强度随 `recoil.flash` 变化。
- 等待装填：`updateGunStatusText()` 每帧刷新 `#scopeStatus` 文字（显示每门炮“装填中 N.Ns” 或 “弹药 x/y”），并给对应的开火按钮加 `.reloading` 样式（变暗）。
- 退出：`exitScope()` 停掉摄像头 track、清掉连发定时器和震屏动画，回到驾驶页面。

### 2.2 刻度线按炮种切换风格（部分已做）
`WEAPON_SYSTEMS[id].reticle` 存着每个武器系统自己的瞄准镜图样名字，`drawReticle(cv)` 按这个名字分发到 `drawReticleSoviet`/`drawReticleGerman`/`drawReticleGeneric`。已经做的两种风格：苏式倒 V 箭头+水平密位刻度（59 式）、德式 TZF 中央大三角+两侧小三角+外圈距离刻度（虎式/鼠式/Sd.Kfz.222）。AMX 50 / 双 57 / 谢尔曼目前还是退回通用十字瞄准镜（`drawReticleGeneric`），法式简洁十字和防空环形瞄准镜还没单独画。

### 2.3 陀螺仪驱动的炮管“延迟跟随”（未做；举镜取消误触发已做）
`GUNS` 里每门炮已经有 `inertia` 字段（转动惯性，大口径数值小、转得慢），但还没有：
- 监听 `DeviceOrientationEvent`/`DeviceMotionEvent.rotationRate`（iOS 需要在点击事件里同步 `requestPermission()`，写法同现有 `enableMotion()`）。
- 画面角落画一截炮管轮廓，用临界阻尼弹簧 `x'' = ω²(target − x) − 2ω·x'` 跟随手机朝向，`ω` 直接取该炮的 `inertia` 值。

已经做的是相关但更简单的一点：举手机瞄准时的晃动不该被现有的"体感起步预判"（§见 `motionStep()`）误判成"车子在动"从而把转速音效拉高。`enterScope()`/`exitScope()` 现在会把全局 `aiming` 置true/false，并清掉 `motionSince`/`preRev`；`loop()` 里 `aiming` 为真时直接把 `pr` 记 0，不读 `motionStep()` 的结果。

### 2.4 开炮后坐的炮管位移（部分未做）
目前只有整体震屏 + 闪光，没有做“炮管沿自身轴线后退再复进”的独立位移动画（原计划里炮管单独后坐、带轻微过冲）。`recoil.kick` 字段已经预留，还没被消费。

### 2.5 安全
瞄准视图里没有任何需要驾驶员操作的东西；仍建议提示“请由乘客操作”（未实现，可在 `enterScope()` 里首次进入时加一次 `alert`/toast）。

---

## 第三部分：乘员角色页面

### 3.1 已实现
顶部 `#roleNav` 六个图标，在所有页面都显示：整车 / 车长 / 驾驶员 / 炮手 / 通讯兵 / 装填手。目前做了三个能点的角色（整车、驾驶员、炮手），车长/通讯兵/装填手三个按钮带 `disabled`，纯占位（样式变暗，点不动）。

- **整车**（`#pageOverview`，默认页面）：现有的驾驶模拟——GPS/手动滑块控制车速，`physicsStep()` 自动换挡，车速触发车长 Halt/Losfahren 口令。
- **驾驶员**（`#pageDriver`）：真正手动开车。油门/刹车/离合三个踏板（按住生效、松手停止，复用开火按钮那套 `bindPress()` 健壮处理），N/1/2/3/4 挡位按钮（不踩离合器直接点挡位会"打齿轮"，播放 `grindGears()` 噪声并拒绝换挡）。`driverPhysicsStep()` 替代 `physicsStep()`：车速只由油门/刹车推动，转速离合时自由升降、结合时跟车速走；GPS/手动滑块、车长语音在这个页面都不生效。离开驾驶员页面（切回整车或点别的角色）立刻改回调用 `physicsStep()`，行驶声音回到默认（GPS/手动）模式。
- **炮手**：就是第二部分做的瞄准镜/开炮界面，`setRole('gunner')` 直接调 `enterScope()`，不再是整车页面里单独一个按钮。退出瞄准镜会把角色切回整车（`exitScope()` 里判断 `activeRole === 'gunner'` 才切，避免切坦克时防御性调用 `exitScope()` 误把驾驶员页面打断）。

### 3.2 还没做
车长、通讯兵、装填手三个角色页面内容。车长可能对应现有的 Halt/Losfahren 口令触发逻辑（现在是自动触发，车长角色也许是让玩家手动按按钮喊话）；装填手可能是把 §1 的装填倒计时做成一个需要玩家主动操作的小游戏，而不是自动计时。这些现在都只是猜测，具体怎么做需要和用户再对一下。

---

## 工作约定
- 只改 `index.html`/`app.js`/`styles.css`（必要时加 `sounds/guns/` 目录并更新 `build_standalone.py` 的内嵌逻辑），保持零构建步骤。
- 所有可调参数集中在 `GUNS` / `WEAPON_SYSTEMS` 两个表里，改手感优先改数值而不是改逻辑。
- 每完成一个阶段：重新生成 `tank-standalone.html`，给用户测试要点和改动摘要，等用户反馈再继续。
- 提交 git 时不要包含 `_backup_recordings/` 和 `tank-standalone.html`。
