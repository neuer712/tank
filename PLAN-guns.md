# 坦克模拟器：火炮系统 + 摄像头瞄准镜 开发计划

> 给 Claude Code 的工作说明。项目在 `D:\GitHub\tank`，部署在 GitHub Pages（`https://neuer712.github.io/tank/`）。
> 用户（熊哥）是程序员，会自己在手机和电脑上试听并反馈。

---

## 0. 现有项目概况（必读）

### 文件
| 文件 | 作用 |
|---|---|
| `index.html` | 页面骨架（HTML + Alpine 模板指令），引用 `styles.css`、`app.js`、`alpine.min.js`，无构建步骤 |
| `styles.css` | 全部样式 |
| `app.js` | 全部逻辑：音频合成、物理、GPS、火炮架构、瞄准镜，以及唯一的 Alpine store（`ui`） |
| `alpine.min.js` | 本地保存的 Alpine.js 3.17.5（从 jsdelivr 下载后 vendor 进仓库，不走 CDN——保持"零外部依赖、离线也能跑"） |
| `sounds/*.wav` | 录音引擎（`engine_idle/high/start/stop.wav`）、录音履带 `track.wav`、地面 `ground.wav` |
| `sounds/halt/1-5.m4a`、`sounds/losfahren/1-5.m4a` | 用户自录的德语口令，随机播放 |
| `build_standalone.py` | 把 `index.html` + `app.js` + `styles.css` + `alpine.min.js` 合并成一个文件，并把 `sounds/` 下的音频以 Base64 Data URI 嵌入，生成 `tank-standalone.html`（双击即可测试，不需要服务器） |
| `_backup_recordings/`、`tank-standalone.html` | **不要提交到 git**（建议加进 `.gitignore`） |

> GitHub Pages 是纯静态托管，`index.html` 引用外部 `app.js`/`styles.css`/`alpine.min.js` 完全没问题——拆文件只是为了让 `index.html` 别无限变长，不影响线上效果。`build_standalone.py` 负责在生成单文件测试版时把它们重新内联回去。

### 界面状态管理：Alpine.js（本地 vendor，非 CDN）
在加了坦克/角色页面/驾驶员推杆之后，界面同步全靠手写 `$('id').textContent=...` / `classList.toggle(...)` /
`document.querySelectorAll(...).forEach(...)` 已经出了好几个 bug（角色栏在顶部和瞄准镜里要分两处手动同步 `.on`
状态，忘了同步一处就出问题）。现在改用 [Alpine.js](https://alpinejs.dev/) 的全局 store 收口：
- `app.js` 里 `document.addEventListener('alpine:init', () => { ui = Alpine.store('ui', {...}); ... })` 注册唯一的
  `ui` store，存了所有会变的界面状态（`activeRole`、`aiming`、`spd`/`rpm`/`gear` 等读数、`drv`、`gunsUi`、
  `currentTankId`、`canSwitchTank` 等）和会被模板调用的方法（`setRole`/`selectTank`/`shiftTo`/`setZoom`/`setMode`/
  `setManVal`/`refreshTankGate`）。物理/音频这些 plain function 不再直接碰 DOM，只管把结果写进 `ui.xxx`。
- `index.html` 用 `x-text`/`x-show`/`:class`/`:disabled`/`x-for` 绑这个 store；角色栏、坦克栏、挡位、开火按钮、
  变焦按钮全部由 `x-for` 按数组声明式渲染，不再手写 `createElement`/`innerHTML`（原来的 `buildTankNav()`/
  `buildScopeButtons()`/`buildZoomButtons()`/`paintLever()` 都删掉了，角色栏的两处 `.on` 同步问题从架构上不可能
  再发生——两处用的是同一个 `x-for` 模板 + 同一个 `$store.ui.activeRole`）。
- **脚本加载顺序很关键，不能反**：`<script src="app.js" defer></script>` 必须排在 `<script src="alpine.min.js" defer></script>`
  **前面**。Alpine 的 cdn 版本在自己的脚本执行完之后用 `queueMicrotask(() => Alpine.start())` 排队启动，`start()`
  会同步触发 `alpine:init` 事件——如果 Alpine 的 `<script>` 先加载，`alpine:init` 会在 `app.js`（后加载的那个）
  挂上监听器之前就已经触发完，store 永远注册不上。`build_standalone.py` 合并单文件版时也保持这个顺序（`js` 文本
  在前，`alpine` 文本在后，拼进同一个 `<script>` 标签）。
- `x-for` 绑的开火按钮用 `x-init="bindFireButton($el, slot.role)"` 在元素刚创建时挂上原有的 `bindPress()`
  指针事件逻辑（保留了之前调好的多点触控 pid 隔离），不需要为了配合 Alpine 重写那套手势代码。
- 这一步改动量很大、而且在这个环境里没有真实浏览器可以跑一遍验证——只做了语法检查（`node --check`）、
  DOM id/`querySelector` 交叉核对、以及对着 `alpine.min.js` 源码尾部确认了启动时机的推断。**用户拿到手机上
  实测后如果角色切换/坦克切换/推杆/开火按钮有问题，先怀疑这一轮的 Alpine 绑定。**

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
- 入口是顶部角色栏的"炮手"图标（不再是驾驶页面里的按钮）：`setRole('gunner')` 直接调用 `enterScope()`。瞄准镜顶部不再是一个"退出瞄准镜"按钮，而是一份迷你角色栏（`.role-nav.mini`，和顶层角色栏共用 `.role-btn` 的事件绑定/高亮逻辑）——点"整车"或"驾驶员"就直接切过去，这本身就是退出瞄准镜的方式。离开炮手角色时统一走 `stopScopeHardware()`（关相机、停连发定时器、停震屏动画），不管是从迷你角色栏点走的（`setRole()` 里判断）还是 `selectTank()` 防御性调用的（`exitScope()`）。
- `enterScope()`：显示全屏遮罩 `#scopeView`，调用 `getUserMedia({video:{facingMode:'environment'}})` 打开后置摄像头，画面接到 `<video>`；**不碰 `loopTimer` / `schedTimer` / `ctx`，驾驶时的引擎声、履带声、车长 Halt/Losfahren 口令继续播放**。已经在瞄准时再点一次炮手图标会直接 `return`，不会重新请求一次摄像头。
- 圆形取景：`.scope-circle` 用 `border-radius:50%; overflow:hidden` 裁剪 `<video>`，上面叠加同样圆形裁剪的 `<canvas>` 画瞄准刻度（`drawReticle()`，见 §2.2）。
- **变焦**：`#scopeZoom` 三个按钮 1×/2.5×/5×。`applyZoom()` 优先用相机硬件变焦（`MediaStreamTrack.getCapabilities().zoom`，目前主要是部分安卓 Chrome 支持），检测不到就退化成对 `<video>` 做 `transform:scale()` 的数码变焦（画质会打折但哪台设备都能用）。
- 开火按钮：`buildScopeButtons()` 按当前武器系统的 `guns` 列表动态生成按钮（主炮 / 同轴 / 炮2），`bindFireButton()` 走 `bindPress()`（见下）实现按住连发。
- 开炮震动：`fireShot()` → `triggerRecoilFX()` 把 `recoil.shake` 累加到全局 `shakeAmp`，`scopeFrame()`（`requestAnimationFrame` 循环）里按衰减系数 0.86/帧 做随机位移 + 轻微旋转的震屏，叠加在 `.scope-stage` 的 CSS `transform` 上。
- 炮口闪光：`flashScope()` 把 `.scope-flash`（圆形径向渐变）的 `opacity` 瞬间拉高再做 CSS transition 淡出，强度随 `recoil.flash` 变化。
- 等待装填：`updateGunStatusText()` 每帧刷新 `#scopeStatus` 文字（显示每门炮“装填中 N.Ns” 或 “弹药 x/y”），并给对应的开火按钮加 `.reloading` 样式（变暗）。
- **`bindPress(el, onStart, onEnd)`**：所有"按住生效、松手停止"按钮（目前是开火键）共用的健壮实现。按下时 `setPointerCapture` 并记住这次按下的 `pointerId`；松开/取消/切后台/失焦都会触发释放，但只有 `pointerId`匹配的那次松开才会真的停下来——这保证了多点触控下一个手指的操作不会牵连另一个手指正按着的控件（同一套 pid 隔离思路也用在了 §3 的离合器/油门/刹车推杆上，见 `bindLever()`）。

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
- **驾驶员**（`#pageDriver`）：真正手动开车，布局是"左手挡杆、右手三个推杆"（`.cockpit` = `.gear-stick` + `.lever-group`，油门/刹车/离合从左到右排列，跟真车踏板顺序一致，只是立起来变成推杆）。
  - 油门/刹车/离合不是开关，是 `bindLever()` 绑定的竖直推杆：在轨道 `.lever-track` 上按住/拖动，`(手指Y − 轨道顶) / 轨道高` 算出 0..1 的量，手柄 `.lever-handle` 跟着贴顶/贴底移动。
  - **多点触控**：`bindLever` 用跟 `bindPress` 一样的 pid 隔离，一个手指拖油门不会影响另一个手指正按着的离合器——这是能一边踩离合一边挂挡的前提。`MULTITOUCH = navigator.maxTouchPoints >= 2` 判断设备到底支不支持：
    - **踩到底松手**（`drv.clutchTarget >= CLUTCH_FLOOR_THRESH`，0.8）：不管支不支持多点触控，都先原地停 `CLUTCH_FLOOR_HOLD`（1 秒，`drv.clutchHoldUntil`）再缓缓回位——留出时间用同一个手指去点挡位按钮，不依赖真正的多点触控也能完成"踩离合→挂挡→松离合"。
    - 没踩到底松手：支持多点触控的话 `drv.clutchReleasing=true`，`driverPhysicsStep()` 用慢得多的时间常数（0.6s vs 跟手指时的 0.03s）缓缓回到 0；不支持的话什么都不做，停在松手瞬间的位置。
    - 油门/刹车不分这几种情况，松手永远回零（`onRelease` 直接把 target 设成 0）。
  - N/1/2/3/4 挡位按钮在 `.gear-stick` 里竖排（点一下挂挡，不是按住），不踩离合器（`drv.clutch < 0.5`）直接点挡位会"打齿轮"，播放 `grindGears()` 噪声并拒绝换挡。
  - `driverPhysicsStep()` 替代 `physicsStep()`：车速只由油门/刹车推动。
    - **离合结合时转速不是独立量**：发动机和车轮硬连接，`engRpm = impliedRpm`（挡位比 × 车速）直接赋值，没有自己的"转速惯性"。松油门之后转速降得快不快，完全取决于车速本身降得快不快——这是故意的：车速衰减的物理量是坦克的动能，换到转速上天然就有"挡位越高、每转对应的车速越高、同样的车速衰减率换算出来的转速衰减率越小"这个效果，不需要再手动按挡位加系数。车速衰减本身用一个固定的匀减速 `COAST_RESIST`（0.45 km/h/s，代表滚动阻力 + 发动机内摩擦），不是"按比例靠近目标速度"那种越慢减速越慢的指数曲线。实测：1 挡松油门转速降约 95~100 转/秒，2 挡约 50 转/秒，和 `COAST_RESIST/GEAR_TOP[gear]*MAX_RPM` 算出来的预测值（97.5 / 53.2）基本对得上。
    - **离合没结合（踩着/空挡）时才是发动机自己的转动惯量**：`FREE_REV_FALL`（900）限制自由升降速率——这时候没有整车动能拖着，松油门转速掉得比结合时快得多，符合直觉。
    - **闷车**：离合结合、挡位挂太高、车速又太低时，`impliedRpm` 跌到怠速 92% 以下就判定为 `lugging`，这时 `torque` 系数把加速能力压到 12%~100% 之间（挡位越不匹配、torque 越低，几乎加不了速），同时每 ~0.2s 播一次 `chugSound()`（低频闷响+噪声），`#driverStatus` 文字也会提示"闷车了，先降挡或踩离合"。**1 挡是起步挡，豁免这条**：`rpmFloor` 在 1 挡时是 `IDLE_RPM` 而不是其他挡位用的 `LUG_FLOOR`，模拟现实里起步靠离合器打滑垫着、转速不会跟着蠕行的车速一起趴下去——否则哪个挡都会被判成闷车，车就永远起不了步。
    - GPS/手动滑块、车长语音在这个页面都不生效。离开驾驶员页面（切回整车或点别的角色）立刻改回调用 `physicsStep()`，行驶声音回到默认（GPS/手动）模式。
- **炮手**：就是第二部分做的瞄准镜/开炮界面，`setRole('gunner')` 直接调 `enterScope()`。瞄准镜顶部的迷你角色栏点其他角色即是"退出瞄准镜"，具体收尾逻辑见 §2.1。
- **换坦克的限制**：`canSwitchTank()` 要求 `activeRole === 'overview' && !running`——只有在整车页面、而且引擎已经熄火，底部坦克栏才能点（否则按钮 `disabled`，灰掉，`#tankNavHint` 会提示"回到整车页面并熄火才能换坦克"）。角色切换（`setRole`）、引擎启动/熄火（`$('start')`/`$('stop')` 的 `onclick`）之后都会重新调用 `buildTankNav()` 刷新这个状态。
- **"体感起步"升转效果在炮手/驾驶员页面要完全关掉，不只是靠手机动没动来判断**：`loop()` 里 `const pr = (aiming || activeRole === 'driver') ? 0 : motionStep(...)`，直接按当前角色短路掉，不依赖 `motionStep()` 自己的判断（举瞄准镜必然会晃手机，驾驶员页面转速已经由油门推杆直接控制，两种情况都不该让加速度计插一脚）。进驾驶员页面时还会顺手清掉 `motionSince`/`preRev` 残留状态。
- **开炮/装填和"引擎有没有启动"是两套独立系统**：以前炮声、装填倒计时都挂在只有按了"启动引擎"才会跑的 `loopTimer`/`ctx` 上，没启动引擎开炮就哑炮、也不装填。现在拆开了：
  - `ensureAudio()`：谁先用到音频系统就谁建（`enterScope()` 进瞄准镜、或 `$('start')` 启动引擎都会调），只建一次，第二次只是 `resume()` + 把 `master` 音量带上去。
  - `engineAudioOn` 标志单独控制发动机音轨的 `engBus` 增益——只有真正按了"启动引擎"才拉到 1，光是炮手用到 `ensureAudio()` 建起音频系统不会漏发动机的声音出来。
  - 装填倒计时 `updateGuns()` 改成从页面加载就跑、独立于 `loopTimer` 的常驻 `setInterval`，不管引擎开没开都在走。

### 3.2 还没做
车长、通讯兵、装填手三个角色页面内容。车长可能对应现有的 Halt/Losfahren 口令触发逻辑（现在是自动触发，车长角色也许是让玩家手动按按钮喊话）；装填手可能是把 §1 的装填倒计时做成一个需要玩家主动操作的小游戏，而不是自动计时。这些现在都只是猜测，具体怎么做需要和用户再对一下。

---

## 工作约定
- 只改 `index.html`/`app.js`/`styles.css`（必要时加 `sounds/guns/` 目录并更新 `build_standalone.py` 的内嵌逻辑），保持零构建步骤。
- 所有可调参数集中在 `GUNS` / `WEAPON_SYSTEMS` 两个表里，改手感优先改数值而不是改逻辑。
- 每完成一个阶段：重新生成 `tank-standalone.html`，给用户测试要点和改动摘要，等用户反馈再继续。
- 提交 git 时不要包含 `_backup_recordings/` 和 `tank-standalone.html`。
