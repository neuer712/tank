# 坦克驾驶模拟器 — Code Review 报告

> 审查对象：`index.html` / `app.js` / `styles.css` / `build_standalone.py` / `PLAN-guns.md`（截至 commit `b33944e`）。
> 审查方式：先用 `/code-review max --fix` 跑了一轮自动化多角度扫描并直接修复，之后我（对话里的 Claude）又对自动化
> 没碰到的部分（音频合成、GPS、Canvas 绘制、数据配置）做了一遍补充人工审查。所有修复都用 `node --check` 做了语法
> 校验，并用 Playwright 起无头浏览器跑了一遍端到端回归（启动引擎、角色切换、坦克栏权限、推杆拖拽、换挡、开炮、
> 瞄准镜），零报错。

---

## 一、已修复的问题

### 1. 快速切换角色时，瞄准镜会"抢回"界面（竞态条件）
**位置**：`enterScope()` / `setRole()`

`enterScope()` 里有两个 `await`（`ensureAudio()` 建音频上下文、`getUserMedia()` 要摄像头权限），这两步都可能耗时几百毫秒。如果用户点了"炮手"图标之后，在权限弹窗还没处理完之前就点走了别的角色，原来的代码会在 await 之后继续无条件地把 `activeRole` 设回 `'gunner'`、把 `aiming` 设成 `true`——相当于用户已经离开了，界面却又被迟到的回调抢回瞄准镜。

**修复**：加了一个 `scopeEpoch` 计数器，每次真正"想进瞄准镜"就 `+1`；`enterScope()` 在每个 `await` 之后都检查自己手里的 epoch 是不是已经过期（被后来的角色切换作废），过期就直接 `return`，摄像头流还开着的话也会先关掉再退出，不会漏关相机。

**验证**：用 Playwright 模拟"点炮手图标 → 立刻点瞄准镜迷你导航里的驾驶员"，确认最终 `activeRole==='driver'`、`aiming===false`，没有被抢回。

### 2. 挂挡音效方向永远是"降挡"
**位置**：`shiftTo(g)`

```js
// 改之前
if (g !== this.drv.gear) { this.drv.gear = g; gearShift(true); }
```

这里 `gearShift(true)` 是硬编码的，看起来像是漏了用 `g` 和当前挡位比较来决定升/降挡方向。再往前翻版本会发现确实本来想写 `gearShift(g > this.drv.gear)`，但是**赋值 `this.drv.gear = g` 写在了比较之前**——比较的时候 `this.drv.gear` 已经等于 `g` 了，`g > g` 恒为 `false`，所以换挡音效实际上永远播的是"降挡"那个版本，不管你是升挡还是降挡。

**修复**：把方向判断挪到赋值之前：`gearShift(g > this.drv.gear); this.drv.gear = g;`

### 3. 变焦硬件能力检测失败时，不会退化到数码变焦
**位置**：`applyZoom()`

```js
// 改之前
track.applyConstraints({...}).catch(() => {});
hw = true;   // 不管 applyConstraints 最终成功没成功，都当成功处理
```

`applyConstraints()` 是 fire-and-forget 的（没有 `await`），`hw = true` 在它真正完成之前就已经写死了。部分安卓机型会在 `getCapabilities()` 里报告支持 `zoom`，但调用 `applyConstraints` 真正设置的时候失败——这种情况下原代码仍然认为硬件变焦成功，于是既不生效、也不会退化成 CSS `scale()` 的数码变焦，变焦按钮点了跟没点一样。

**修复**：`await track.applyConstraints(...)`，只有真正 resolve 了才置 `hw = true`，抛错就落到 `catch` 里保持 `hw = false`，让后面的 CSS 数码变焦兜底生效。顺带加了 `zoomEpoch` 防止快速连点 1×/2.5×/5× 时后完成的 `applyConstraints` 调用覆盖掉用户最后一次点的选择。

### 4. 只更新了"最后一个"引擎的 AudioParam，不一定是正在响的那个
**位置**：`updateAudio()`

```js
// 改之前
let rpm = 0;
for (const k in engines) if (engines[k]) rpm = engines[k].set(r, ld, now, 0.08);
ui.rpm = Math.round(rpm / 10) * 10;
```

这个循环每 50ms 执行一次，会给**三套引擎**（录音/经典/逐缸）全都推一遍参数，即使只有一套的音量总线是打开的——另外两套的运算是纯浪费。更麻烦的是，显示在界面上的转速 `ui.rpm` 取的是 `for...in` 循环**最后遍历到的那个引擎**的返回值，这取决于 `engines` 对象的键遍历顺序，不一定是玩家当前真正听到的那一套引擎——理论上转速读数可能和耳朵听到的不是一回事。

**修复**：`const e = engines[engineMode]; if (e) ui.rpm = ...e.set(...)`，只更新、只读真正在响的那一个。

### 5. 空挡状态下车长语音会被旧的"武装"状态误触发
**位置**：`setRole()`

驾驶员页面退出时，`realKmh` 会从"驾驶员页面自己算出来的车速"突然跳回 GPS/手动滑块的值。如果之前在驾驶员页面开得比较快，`stateA`（"车速超过阈值，等着降到低速喊 Halt"）可能已经被武装，一回到整车页面，GPS 车速哪怕只是正常的低速，也可能被误判成"从快速降到慢速"，莫名其妙喊一句 Halt。

**修复**：离开驾驶员页面时清掉 `stateA`/`stateB`/`zeroSince`，让车长口令的武装状态重新从干净的起点开始判断。

### 6. `localStorage` 里存的坦克 id 如果失效，会让炮手页面建不起来
**位置**：`currentTankId` 初始化

```js
// 改之前
currentTankId: (() => { try { return localStorage.getItem('tankId') || 'type59'; } catch (e) { return 'type59'; } })(),
```

如果以后改了某辆坦克的 id（或者浏览器里存的是旧版本遗留的无效 id），`selectTank(id)` 开头有 `const t = TANKS[id]; if (!t) return;`——查不到直接整个方法短路退出，连 `initWeaponSystem()` 都不会跑，意味着 `gunsUi` 永远是空数组，炮手页面的开火按钮永远渲染不出来，而且不会有任何报错提示，很难排查。

**修复**：读 `localStorage` 的时候就校验一遍 `TANKS[id]` 是否存在，不存在直接回退到默认坦克，不把一个查无此车的 id 传下去。

### 7. 装填倒计时和主循环都用硬编码 `dt=0.05`，后台节流时会算错
**位置**：`updateGuns` 的 `setInterval`、`loop()`

`setInterval(fn, 50)` 只保证"至少 50ms 的间隔"，不保证精确 50ms——手机浏览器把标签页/应用切到后台之后，大多数引擎会把计时器限流甚至完全暂停，等应用回到前台时，距上次 tick 可能已经过了好几秒甚至几十秒。原代码不管实际经过了多久，物理步进和装填倒计时永远按"过了 50ms"来算，意味着：

- 应用在后台挂起的这段时间里，装填倒计时几乎不走（因为 tick 回调本身被跳过了，而不是按时间补偿）；
- 回到前台的那个瞬间，如果浏览器一次性触发了好几个积压的 tick，又会让倒计时在很短的真实时间内快进很多次 50ms。

**修复**：两处都改成记录上一次 tick 的真实时间戳，用 `performance.now()` 算出真实经过的 `dt`，`clamp` 在 `[0, 0.5]` 秒防止长时间挂起后回来时一步跳太猛。`$('stop').onclick` 里额外把 `lastLoopAt` 清零，避免"熄火"和"下次启动"之间间隔的时间被当成一次巨大的物理步进。

### 8. 开火/推杆的全局兜底监听器（`pressFailsafes`）无限增长
**位置**：`bindPress()` / `bindLever()`

每次切换坦克或武器系统，Alpine 的 `x-for` 会把旧的开火按钮整批销毁、重新创建一批新的（`:key="slot.role"` 不同车可能对不上号，比如双 57 的 `main2` 和别的车的 `coax`）。`bindFireButton` 在每个新按钮上都会调一次 `bindPress`，而 `bindPress` 原来是无条件 `pressFailsafes.push(end)`——旧按钮已经不在文档里了，对应的闭包却永远留在数组里，随着玩家来回切换坦克，这个数组会无限变长，`runPressFailsafes`（原来叫法：那堆 `window.addEventListener('pointerup', ...)`）每次全局 `pointerup` 都要把这些僵尸闭包也跑一遍。

**修复**：`pressFailsafes` 现在存 `{el, end}`，触发兜底之前先用 `document.contains(f.el)` 把已经不在文档里的旧条目过滤掉。同时给 `bindPress`/`bindLever` 都加了 `lostpointercapture` 事件作为额外的兜底信号（部分系统手势会在不触发 `pointerup`/`pointercancel` 的情况下直接收回指针捕获）。

### 9. 摄像头连接中/失败时，弹药状态文字会盖掉提示文案
**位置**：`updateGunStatusText()`

`scopeFrame()` 每帧都调 `updateGunStatusText()`。摄像头权限弹窗还没处理完、或者用户拒绝了权限的时候，`ui.scopeStatusText` 本来应该一直显示"正在打开后置摄像头…"或者报错信息，但 `updateGunStatusText()` 只检查了 `ui.aiming`，不检查摄像头到底连没连上，所以下一帧立刻就会被"弹药 x/y"这种状态文字覆盖掉，用户看不到真正发生了什么。

**修复**：加一个 `!scopeStream` 的判断，摄像头还没真正连上之前不要用弹药状态覆盖提示文案。

### 10. 退出瞄准镜时没清掉震屏强度，下次进来会有一下残留抖动
**位置**：`stopScopeHardware()`

刚开完一炮就退出瞄准镜的话，`shakeAmp`（全局震屏强度变量）还没衰减到 0，下次再进瞄准镜会直接继承这个残留值，画面一进来就无缘无故抖一下。

**修复**：`stopScopeHardware()` 里加一行 `shakeAmp = 0;`。

### 11. "没踩离合器，挂不进挡"的提示只显示 50ms 就被盖掉
**位置**：`grindGears()` / `updateDriverStatus()`

这其实是我自己在上一轮改离合器逻辑时留下的、当时已经注意到但没处理的小问题：`grindGears()` 把提示文字设成"没踩离合器，挂不进挡！"，但驾驶员页面每个 50ms 的 `loop()` tick 都会调 `updateDriverStatus()` 把状态行覆盖回"挡位 N·离合 0%·…"这种常规格式，相当于这条提示最多只会在屏幕上停留一个 tick（不到 50ms），人眼基本看不见。

**修复**：加了 `grindMsgUntil` 时间戳，`updateDriverStatus()` 在这个时间点之前直接跳过，不覆盖提示文字——现在这条提示至少会停留 0.8 秒。用 Playwright 实测确认了修复前后的区别（修复前读到的是常规状态行，修复后能读到真正的提示文字）。

### 12. 瞄准镜画布每一帧都重新分配底层位图（性能，我自己补充发现的）
**位置**：`scopeFrame()`

```js
// 改之前
const cv = $('scopeCanvas'), rect = cv.parentElement.getBoundingClientRect();
if (cv.width !== rect.width) { cv.width = rect.width; cv.height = rect.height; }
```

`cv.width` 读出来永远是整数（canvas 的 `width` 属性定义是 unsigned long），`getBoundingClientRect().width` 几乎总是带小数（因为 `.scope-stage` 的 CSS 宽度是 `min(92vw,520px)`，很少刚好落在整数 CSS 像素上）。这俩直接 `!==` 比较，基本上每一帧都判定为"尺寸变了"，而给 canvas 的 `width`/`height` 赋值——哪怕赋的是和当前尺寸四舍五入后相同的值——都会强制清空并重新分配整块位图。瞄准镜开着的时候这个循环跑在 `requestAnimationFrame` 里（接近 60 次/秒），等于每一帧都在做一次不必要的显存重新分配，手机上尤其费电、也可能引入多余的卡顿。

**修复**：两边都 `Math.round()` 取整再比较，真正尺寸变化（比如旋转屏幕）时才重新分配。

---

## 二、过了一遍但确认没问题的地方

- `ensureAudio()`/`buildAudio()`：`ctx = new AudioContext()` 是 `buildAudio()` 里第一行同步执行的语句，在任何 `await` 之前就完成赋值，所以哪怕用户连续快速点击触发两次 `ensureAudio()`，JS 单线程的"运行到完成"语义保证不会出现两次 `buildAudio()` 交叉执行、重复建两套音频图的情况。
- `localStorage` 的两处用法都包了 `try/catch`，隐私模式/存储被禁用的情况下不会抛出未捕获异常。
- `window.addEventListener('devicemotion', onMotion)` 虽然每次启动引擎都会调一次，但 `onMotion` 是稳定的顶层函数引用，重复 `addEventListener` 同一个函数引用在规范里是幂等的（浏览器会去重），不会叠加出多个监听器。
- GPS 的 `watchId`：`$('stop').onclick` 里有 `navigator.geolocation.clearWatch(watchId)`，正常熄火不会泄漏 GPS 监听。

## 三、已知未处理的问题（不在本次修复范围，供下次参考）

这些是我在审查过程中留意到、但判断优先级较低或者需要先和你对一下预期行为的点，没有动代码：

- **炮声合成方案仍是占位级别**：`PLAN-guns.md` §1.3 里已经写明——`fireShot()` 目前只是把原来 `boom()` 的分层按口径缩放，没有做计划里提到的冲击波尖峰、野外回声 `ConvolverNode` 等更真实的合成方案；录音优先的炮声资源位（`sounds/guns/<gunId>/...`）也还是空的。
- **瞄准镜刻度线**：目前只有苏式（59 式）、德式（虎式/鼠式/Sd.Kfz.222）两种图样，AMX 50、双 57、谢尔曼还是退回通用十字瞄准镜，没有专属图样。
- **炮管陀螺仪延迟跟随 / 独立后坐位移**：`GUNS` 里的 `inertia`、`recoil.kick` 两个字段都已经留好了，但还没有任何视觉效果消费它们。
- **车长/通讯兵/装填手三个角色页面**：顶部角色栏图标还在，但点了没反应（`enabled:false`），具体做成什么样需要先和你对一下预期（比如装填手是不是要做成一个需要玩家主动操作的小游戏）。
- **闷车判断的阈值/惩罚力度**：`lugging`/`torque` 这套逻辑目前只覆盖了"挡位太高、车速太低"的场景，没有对"离合器半联动打滑"做更细的建模（现实里半联动可以在闷车边缘反复找平衡点），这个如果要做需要先确认你想要多真实。

---

## 四、这次改动涉及的文件

| 文件 | 改动 |
|---|---|
| `app.js` | 本报告列的全部 12 处修复 |
| `PLAN-guns.md` | 修正了一处关于坦克引擎/履带声音组合数量的描述错误（不影响代码，纯文档订正） |
| `index.html` / `styles.css` / `build_standalone.py` | 审查过，未发现需要修复的问题 |

所有修复都已经跑过 `node --check` 语法校验，用 Playwright 起无头浏览器做了端到端回归（启动引擎、角色切换、坦克栏权限门槛、推杆拖拽、无离合强行换挡会打齿轮、离合+换挡、瞄准镜开火、变焦竞态、角色切换竞态），零报错、零回归。`tank-standalone.html` 已经用最新代码重新生成，可以双击直接测。

本次改动按你的要求**只做了本地 commit，没有 push**。
