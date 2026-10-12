'use strict';
const $ = id => document.getElementById(id);
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light';
  $('theme-toggle').textContent = light ? '☾ 黑暗模式' : '☀ 明亮模式';
  $('theme-toggle').setAttribute('aria-pressed', String(light));
  $('theme-toggle').title = '当前：' + (light ? '明亮模式' : '黑暗模式');
}
applyTheme(document.documentElement.dataset.theme || 'dark');
$('theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(theme);
  try { localStorage.setItem('lumen-bench-theme', theme); } catch { $('settings-status').textContent='主题保存失败，请导出全部设置备份'; }
});
let config;
try { config = Bench.validate(JSON.parse(localStorage.getItem('lumen-bench-config') || 'null')); }
catch { config = { ...Bench.DEFAULTS }; }
let channel = null, port = null, reader = null, writer = null, readTask = null;
let connected = false, connecting = false, closing = false, opBusy = false, session = 0, toastTimer;
let demoPos = { X:0, Y:0, Z:0 }, demoRelative = false;
// Simulated hardware so every panel can be exercised with no machine attached:
// a virtual feeder bus plus fixed vacuum and TMC responses.
const feederDemoBus = Bench.demoFeederNetwork();
const demoVacuum = { side: 1, register: 6, table: { 1: [0xFF, 0xFB, 0x50], 2: [0xFF, 0xFB, 0x80] } };
const demoTmcReport = ['SENDING:M122', '\tX\tY\tZ\tE', 'Enabled\ttrue\ttrue\ttrue\tfalse', 'Set current\t800\t800\t800\t0',
  'RMS current\t800\t800\t800\t0', 'MAX current\t800\t800\t800\t0', 'Run current\t800\t800\t800\t0', 'Hold current\t400\t400\t400\t0',
  'Driver registers:', '\tX\t0x00:0x80:0x00:0x40', '\tY\t0x00:0x80:0x00:0x40', '\tZ\t0x00:0x80:0x00:0x40', '（演示数据，未读取真实驱动）'];
let lastPosition = null;
let prefs;
try { prefs=Bench.preferences(JSON.parse(localStorage.getItem('lumen-bench-preferences')||'{}')); } catch { prefs=Bench.preferences(); }
let xyStep = prefs.xyStep, zStep = prefs.zStep, pendingImport = null;
let motionStopped = false, stopBusy = false, stopDelivered = false, recoveryBusy = false, requiresHome = false;
const states = {}, logEntries = [], cameraSlots = {};
let endstopRequest=null;
// Passive line sinks. The acknowledged-command matcher ignores anything that is not
// a reply regex match, so the feeder bus (`rs485-reply:`) and the vacuum ADC
// (`data:`) lines are captured here instead.
const lineTaps = new Set();
function tapLines(fn) { lineTaps.add(fn); return () => lineTaps.delete(fn); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hexByte = n => '0x' + (Number(n) & 0xff).toString(16).toUpperCase().padStart(2, '0');
function renderEndstops(entries=[]) {
  const list=$('endstop-states');list.replaceChildren();
  const rows=[...entries];
  for(const a of ['x','y','z'])if(!rows.some(r=>new RegExp('^'+a+'(?:\\d+)?_').test(r.name)))rows.push({name:a.toUpperCase()+' 限位',triggered:null});
  for(const item of rows){const row=document.createElement('div');row.className='endstop-card '+(item.triggered===null?'unknown':item.triggered?'triggered':'open');const name=document.createElement('b'),status=document.createElement('span');name.textContent=item.name;status.textContent=item.triggered===null?'未回报':item.triggered?'● 已触发':'○ 未触发';row.append(name,status);list.append(row);}
}
function resetEndstops(){endstopRequest=null;renderEndstops();$('endstop-status').textContent='尚未检测 · 点击按钮读取当前状态';}
const outputs = [
  ['lightTop','顶部照明','上摄像头环形灯','☀'],['lightBottom','底部照明','下摄像头环形灯','☀'],
  ['pumpLeft','左气泵','P0 · MOS1','◉'],['pumpRight','右气泵','P2 · MOS3','◉'],
  ['valveLeft','左阀门','P1 · MOS2','◇'],['valveRight','右阀门','P3 · MOS4','◇']
];
function savePreferences() {
  prefs=Bench.preferences(prefs);
  try {localStorage.setItem('lumen-bench-preferences',JSON.stringify(prefs));localStorage.setItem('lumen-bench-config',JSON.stringify(config));localStorage.setItem('lumen-bench-theme',document.documentElement.dataset.theme);$('settings-status').textContent='设置已自动保存 · 本地运行';return true;}
  catch { $('settings-status').textContent='保存失败，请导出全部设置备份';return false; }
}
function applyPreferences(next) {
  prefs=Bench.preferences(next);xyStep=prefs.xyStep;zStep=prefs.zStep;
  $('mode').value=prefs.mode;$('feed').value=prefs.feed;$('feed-z').value=prefs.feedZ;
  $('xy-step-display').textContent=xyStep;$('xy-step-foot').textContent=xyStep+' mm';$('z-step-foot').textContent=zStep+' mm';
  document.querySelectorAll('[data-step]').forEach(b=>{const selected=Number(b.dataset.step)===(b.dataset.group==='xy'?xyStep:zStep);b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});
  document.querySelectorAll('[data-ring]').forEach(r=>r.classList.toggle('selected-ring',Number(r.dataset.ring)===xyStep));
  for(const side of ['left','right'])for(const suffix of ['Angle','Target','Feed'])$(side+'-'+suffix.toLowerCase()).value=prefs[side+suffix];
  for(const key of ['top','bottom']){
    $('rotation-'+key).value=prefs[key+'Rotation'];$('mirror-'+key).checked=prefs[key+'Mirror'];$('cross-toggle-'+key).checked=prefs[key+'Cross'];
    const select=$('device-'+key),id=prefs[key+'Device'];
    if(id && ![...select.options].some(o=>o.value===id))select.add(new Option((prefs[key+'DeviceLabel']||'已保存的摄像头')+' · 等待授权',id));
    if(id)select.value=id;applyCameraView(key);
  }
  for(const key of Object.keys(Bench.PREFS.strength)){const slider=$('strength-'+key);if(!slider)continue;slider.value=prefs.strength[key];$('strength-value-'+key).textContent=prefs.strength[key];}
}
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 5500); }
function log(type, message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12:false });
  logEntries.push(`${time} ${type.toUpperCase()} ${message}`); if (logEntries.length > 2000) logEntries.shift();
  const row = document.createElement('div'); row.className = 'log-line ' + type;
  const clock = document.createElement('time'); clock.textContent = time;
  const badge = document.createElement('span'); badge.className='type'; badge.textContent = ({tx:'TX →',rx:'RX ←',info:'·',error:'!'}[type]);
  const content = document.createElement('span'); content.textContent = message;
  row.append(clock,badge,content); $('log').append(row);
  if ($('log').children.length > 500) $('log').firstElementChild.remove();
  $('log').scrollTop = $('log').scrollHeight;
}
function download(name, content, type='text/plain') {
  const url = URL.createObjectURL(new Blob([content], {type})); const a=document.createElement('a'); a.href=url;a.download=name;a.click();setTimeout(() => URL.revokeObjectURL(url),1000);
}
function stamp() { const d=new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`; }
function resetState() {
  resetEndstops();
  for (const [key] of outputs) states[key] = null;
  lastPosition=null; for (const a of ['X','Y','Z']) $('pos-'+a).textContent='—';
  for(const side of ['left','right']){if($('nozzle-pos-'+side))$('nozzle-pos-'+side).textContent='—';$('vac-value-'+side).textContent='—';}
  $('position-source').textContent='坐标尚未读取'; renderStates();
}
function renderStates() {
  for (const [key] of outputs) {
    const node=$('state-'+key); node.textContent=states[key] === null ? '未知' : states[key] ? '已开' : '已关'; node.classList.toggle('on',states[key]===true);
    document.querySelectorAll(`[data-output="${key}"]`).forEach(b => b.classList.toggle('active', states[key]!==null && states[key]=== (b.dataset.value==='on')));
  }
  $('light-mode').textContent=config.sharedLights ? '上下联动' : '独立指令';
}
function render() {
  const mode=$('mode').value, locked = !connected || connecting || closing || opBusy || recoveryBusy || feederScanning || channel?.halted || (mode==='serial' && !$('armed').checked);
  document.querySelectorAll('[data-hardware]').forEach(b=>b.disabled=!!locked || (requiresHome && (!!b.dataset.axis || !!b.dataset.nozzle || b.closest('#command-form') !== null)));
  document.querySelectorAll('[data-endstops]').forEach(b=>b.disabled=!connected||connecting||closing||opBusy||recoveryBusy||!!channel?.halted);
  $('stop-notice').hidden = !motionStopped && !requiresHome;
  $('stop-message').textContent = motionStopped ? (stopBusy ? '停止请求发送中；连接保持' : !stopDelivered ? '停止请求写入失败；运动已锁定，请使用物理急停。' : !canResume() ? '连接保持；自定义停机指令需人工检查，M112 需要复位主控。' : '已发送停止请求；连接保持。检查机器后解除急停，再全部回零。') : '控制已恢复；坐标需重新确认，请先全部回零。';
  $('resume-control').hidden = !motionStopped;
  $('resume-control').disabled = !connected || connecting || closing || stopBusy || !stopDelivered || opBusy || recoveryBusy || !canResume();
  $('resume-control').textContent = recoveryBusy ? '同步控制器…' : '解除急停';
  $('connect').disabled = connected || connecting || closing;
  $('disconnect').disabled = !connected || closing;
  $('mode').disabled = connected || connecting || closing;
  $('baud').disabled = connected || connecting || closing;
  $('armed').disabled=mode==='demo' || !connected || channel?.halted || opBusy;
  $('arm-note').hidden=mode!=='serial';
  $('settings-open').disabled=connecting || closing;
  $('connect').textContent=connecting?'正在连接…':mode==='demo'?'连接演示设备':'选择 USB 串口';
  $('connection-status').textContent=closing?'● 正在断开':connecting?'● 正在连接':!connected?'● 未连接':motionStopped?'● 已连接 · 急停锁定':channel?.halted?'● 已连接 · 通信异常':mode==='demo'?'● 演示已连接':'● 串口已连接';
  $('connection-status').className='badge'+(connected?(mode==='demo'?' demo':' connected'):'');
  $('operation-status').textContent=motionStopped?'急停锁定 · 连接保持':channel?.halted?'通信异常 · 运动锁定':opBusy||recoveryBusy?'等待控制器确认…':requiresHome?'请先全部回零':connected?'就绪':'等待连接';
  document.body.classList.toggle('busy',opBusy);
}
for (const a of ['X','Y','Z']) {
  const row=document.createElement('div');row.className='axis-readout';
  row.innerHTML=`<span class="axis-name">${a}</span><div class="coordinate"><span id="pos-${a}">—</span><small>mm</small></div>`;
  $('axis-readouts').append(row);
}
$('axes').innerHTML=`<div class="jog-layout">
  <div class="xy-area"><div class="controller-caption"><span>XY 平面</span><small>独立轴点动</small></div>
    <div class="xy-pad">
      <button id="stop" class="emergency-icon" aria-label="软件急停" title="快速停止电机运动，保持串口连接"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M12 2H28L38 12V28L28 38H12L2 28V12Z"/><rect x="13" y="13" width="14" height="14" rx="2"/></svg><span>急停</span></button>
      <svg class="dial-art" viewBox="0 0 320 320" aria-hidden="true"><defs><radialGradient id="dial-bg"><stop offset="0" stop-color="#17283a"/><stop offset="1" stop-color="#101925"/></radialGradient></defs><circle cx="160" cy="160" r="140" fill="url(#dial-bg)" stroke="#35485c"/><circle class="dial-ring" data-ring="10" cx="160" cy="160" r="126"/><circle class="dial-ring" data-ring="5" cx="160" cy="160" r="99"/><circle class="dial-ring selected-ring" data-ring="1" cx="160" cy="160" r="72"/><circle class="dial-ring" data-ring="0.1" cx="160" cy="160" r="45"/><path d="M49 49L271 271M271 49L49 271" stroke="#1b2938" stroke-width="12"/><path d="M49 49L271 271M271 49L49 271" stroke="#35485c" stroke-width="1"/></svg>
      <button class="dial-home home-x" data-command="homeX" data-hardware aria-label="X 回零"><span>⌂</span><b>X</b></button>
      <button class="dial-home home-y" data-command="homeY" data-hardware aria-label="Y 回零"><span>⌂</span><b>Y</b></button>
      <button class="dial-home home-all" data-command="homeAll" data-hardware aria-label="全部回零"><span>⌂</span><b>全部</b></button>
      <button class="direction dir-up" data-axis="Y" data-sign="1" data-hardware aria-label="Y 轴正向点动"><span>▲</span><b>+Y</b></button>
      <button class="direction dir-right" data-axis="X" data-sign="1" data-hardware aria-label="X 轴正向点动"><span>▶</span><b>+X</b></button>
      <button class="direction dir-down" data-axis="Y" data-sign="-1" data-hardware aria-label="Y 轴负向点动"><span>▼</span><b>−Y</b></button>
      <button class="direction dir-left" data-axis="X" data-sign="-1" data-hardware aria-label="X 轴负向点动"><span>◀</span><b>−X</b></button>
      <div class="dial-center"><span>XY</span><b id="xy-step-display">1</b><small>mm / 次</small></div>
      ${[0.1,1,5,10].map((s,i)=>`<button class="dial-step step-${i} ${s===1?'selected':''}" data-step="${s}" data-group="xy" aria-label="XY 步长 ${s} mm" aria-pressed="${s===1}">${s}</button>`).join('')}
    </div><div class="controller-footnote"><i></i><span>XY 步长</span><b id="xy-step-foot">1 mm</b></div>
  </div>
  <div class="z-area"><div class="controller-caption"><span>Z 轴</span><small>垂直</small></div><div class="z-track">
    <button class="z-home" data-command="homeZ" data-hardware aria-label="Z 回零">⌂ <b>Z</b></button>
    <button class="direction z-up" data-axis="Z" data-sign="1" data-hardware aria-label="Z 轴正向点动"><span>▲</span><b>+Z</b></button>
    <div class="z-steps">${[10,5,1,0.1].map(s=>`<button class="z-step ${s===0.1?'selected':''}" data-step="${s}" data-group="z" aria-label="Z 步长 ${s} mm" aria-pressed="${s===0.1}">${s}</button>`).join('')}</div>
    <button class="direction z-down" data-axis="Z" data-sign="-1" data-hardware aria-label="Z 轴负向点动"><span>▼</span><b>−Z</b></button>
  </div><div class="controller-footnote"><b id="z-step-foot">0.1 mm</b></div></div>
</div>`;
for(const [side,name,axis]of [['left','左吸嘴 · N1','A'],['right','右吸嘴 · N2','B']]){
  const box=document.createElement('div');box.className='nozzle-card';
  box.innerHTML=`<div class="nozzle-heading"><b>${name}</b><span><small id="nozzle-axis-${side}">${axis}</small> <strong id="nozzle-pos-${side}">—</strong> °</span></div><div class="nozzle-inputs"><label>每次角度 °<input id="${side}-angle" type="number" min="0.1" max="360" step="0.1" value="45"></label><label>速度 °/min<input id="${side}-feed" type="number" min="1" max="10000" value="600"></label></div><div class="nozzle-presets">${[15,45,90,180].map(v=>`<button data-nozzle-preset="${side}" data-angle="${v}">${v}°</button>`).join('')}</div><div class="action-row"><button data-nozzle="${side}" data-direction="cw" data-hardware>↻ 顺时针</button><button data-nozzle="${side}" data-direction="ccw" data-hardware>↺ 逆时针</button></div><div class="nozzle-target"><label>绝对角度 °<input id="${side}-target" type="number" min="-360" max="360" step="0.1" value="0"></label><button data-nozzle="${side}" data-direction="absolute" data-hardware>转到角度</button></div></div>`;
  $('nozzles').append(box);
}
// Pneumatic outputs carry a 0–255 power slider that feeds the S word of the on-command.
const strengthKeys = Object.keys(Bench.PREFS.strength);
for (const [key,title,subtitle,icon] of outputs) {
  const row=document.createElement('div');row.className='io-row';
  const slider=strengthKeys.includes(key)?`<div class="io-strength"><input id="strength-${key}" type="range" min="0" max="255" step="1" value="${prefs.strength[key]}" aria-label="${title}力度"><output id="strength-value-${key}">${prefs.strength[key]}</output></div>`:'';
  row.innerHTML=`<span class="io-icon">${icon}</span><span class="io-title">${title}<small>${subtitle}</small></span><span id="state-${key}" class="io-state">未知</span><div class="io-buttons"><button data-output="${key}" data-value="on" data-hardware>开</button><button data-output="${key}" data-value="off" data-hardware>关</button></div>${slider}`;
  $(key.startsWith('light')?'lights':'pneumatics').append(row);
}
for (const key of strengthKeys) {
  const slider=$('strength-'+key);
  slider.addEventListener('input',()=>{$('strength-value-'+key).textContent=slider.value;});
  // Re-apply on release only: dragging must not flood the serial line.
  slider.addEventListener('change',()=>{prefs.strength[key]=Number(slider.value);savePreferences();if(states[key]===true)resendStrength(key);});
}
function resendStrength(key) {
  let command;
  try {command=Bench.withStrength(config[key+'On'],prefs.strength[key]);}
  catch(e) {$('strength-'+key).value=prefs.strength[key];$('strength-value-'+key).textContent=prefs.strength[key];toast(e.message);return;}
  run(command,()=>log('info',`${key} 力度已设为 ${prefs.strength[key]}`),false,true);
}
function acceptLine(line, sourceChannel) {
  if(endstopRequest?.channel===sourceChannel){const state=Bench.endstop(line);if(state)endstopRequest.entries.set(state.name,state);}
  for(const tap of lineTaps)tap(line);
  sourceChannel.receive(line);
  const p=Bench.position(line);
  if(p && (!motionStopped || recoveryBusy)) { lastPosition={...(lastPosition||{}),...p}; for(const a of ['X','Y','Z']) if(p[a]!==undefined) $('pos-'+a).textContent=p[a].toFixed(3); for(const side of ['left','right']){const a=config['nozzle'+(side==='left'?'Left':'Right')+'Axis'];if(p[a]!==undefined)$('nozzle-pos-'+side).textContent=p[a].toFixed(2);} $('position-source').textContent=($('mode').value==='demo'?'演示坐标 · ':p.source+' · ')+new Date().toLocaleTimeString('zh-CN',{hour12:false})+(requiresHome?' · 需全部回零确认':''); }
}
async function readSerial(sourcePort, sourceChannel, token) {
  let buffer='', decoder=new TextDecoder();
  const sourceReader=sourcePort.readable.getReader(); reader=sourceReader;
  try {
    while(connected && session===token) {
      const {value,done}=await sourceReader.read(); if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      const rows=buffer.split(/[\r\n]/);buffer=rows.pop();
      for(const row of rows) if(row.trim() && session===token) acceptLine(row.trim(),sourceChannel);
      if(buffer.length>16384) throw Error('串口接收行过长，请检查波特率和行结束符');
    }
    if(connected && !closing && session===token) throw Error('串口读取已结束');
  } catch(e) { if(!closing && session===token){sourceChannel.cancel('串口连接中断');$('armed').checked=false;log('error',e.message);toast('串口连接中断，请断开后重连');render();} }
  finally { sourceReader.releaseLock(); if(reader===sourceReader)reader=null; }
}
function simulate(row, demoChannel, token) {
  const code=row.trim().split(';')[0].trim();
  if(/^G91\b/i.test(code))demoRelative=true;
  if(/^G90\b/i.test(code))demoRelative=false;
  if(/^G[01]\b/i.test(code))for(const a of ['X','Y','Z','A','B']){const m=code.match(new RegExp(a+'(-?\\d+(?:\\.\\d+)?)','i'));if(m)demoPos[a]= (demoRelative?demoPos[a]:0)+Number(m[1]);}
  if(/^G28\b/i.test(code)){const axes=['X','Y','Z'].filter(a=>new RegExp('\\b'+a+'\\b','i').test(code));for(const a of axes.length?axes:['X','Y','Z'])demoPos[a]=0;}
  // I2C bridge traffic is tracked so the simulated M261 answers the register that
  // was last addressed, exactly like the real sensor does.
  if(/^M260\b/i.test(code)){
    const addr=code.match(/\bA(\d+)/i),reg=code.match(/\bB(\d+)/i);
    if(addr&&Number(addr[1])===112&&reg)demoVacuum.side=Number(reg[1]);
    else if(addr&&Number(addr[1])===109&&reg)demoVacuum.register=Number(reg[1]);
  }
  setTimeout(()=>{
    if(session!==token || !connected || (demoChannel.halted && !/^M118\b/i.test(code)))return;
    if(/^M118\b/i.test(code))acceptLine(code.replace(/^M118\s+/i,''),demoChannel);
    if(/^M485\b/i.test(code)){
      const request=Bench.feederRequest(Bench.parseHex(code.replace(/^M485\s+/i,'')));
      const bytes=request?feederDemoBus.handle(request):null;
      acceptLine(bytes?'rs485-reply: '+Bench.toHex(bytes):'rs485-reply: TIMEOUT',demoChannel);
    }
    if(/^M261\b/i.test(code)){
      const table=demoVacuum.table[demoVacuum.side]||demoVacuum.table[1];
      const index=Bench.VACUUM.registers.indexOf(demoVacuum.register);
      const value=index<0?0:table[index];
      acceptLine('data:'+value.toString(16).toUpperCase().padStart(2,'0'),demoChannel);
    }
    if(/^M122\b/i.test(code))for(const line of demoTmcReport)acceptLine(line,demoChannel);
    if(/^M114\b/i.test(code))acceptLine(`X:${demoPos.X.toFixed(3)} Y:${demoPos.Y.toFixed(3)} Z:${demoPos.Z.toFixed(3)} A:${demoPos.A.toFixed(3)} B:${demoPos.B.toFixed(3)}`,demoChannel);
    if(/^M115\b/i.test(code))acceptLine('FIRMWARE_NAME:Marlin (演示响应，未读取硬件)',demoChannel);
    if(/^M119\b/i.test(code)){acceptLine('Reporting endstop status',demoChannel);for(const line of ['x_min: open','y_min: TRIGGERED','z_min: open'])acceptLine(line,demoChannel);}
    acceptLine('ok',demoChannel);
  },80);
}
$('connect').addEventListener('click', async()=>{
  connecting=true;motionStopped=false;stopBusy=false;$('armed').checked=false;resetState();render(); const token=++session;
  try {
    config.baud=Number($('baud').value);
    if($('mode').value==='serial') {
      if(!navigator.serial)throw Error('当前浏览器不支持 Web Serial，请使用 Chrome / Edge 并通过 localhost 打开');
      port=await navigator.serial.requestPort();
      await port.open({baudRate:config.baud,dataBits:8,stopBits:1,parity:'none',flowControl:'none',bufferSize:8192});
      writer=port.writable.getWriter();
      channel=new Bench.Channel(data=>writer.write(new TextEncoder().encode(data)), {...config},log);
      connected=true;readTask=readSerial(port,channel,token);
      log('info',`USB 串口已打开 · ${config.baud} baud；等待主控启动 ${config.settle} ms`);
      await new Promise(resolve=>setTimeout(resolve,config.settle));
      if(channel.halted)throw Error('串口异常，请检查设备');
      log('info','就绪；核对配置后勾选“允许硬件控制”，连接时不自动发送指令');
    } else {
      demoPos={X:0,Y:0,Z:0,A:0,B:0};demoRelative=false;
      channel=new Bench.Channel(async data=>simulate(data,channel,token),{...config},log);connected=true;log('info','演示设备已连接；所有设备响应均为模拟');
    }
  } catch(e) { log('error',e.message);toast(e.message);if(port)await disconnect(); }
  finally {connecting=false;render();}
});
async function disconnect() {
  if(closing)return;closing=true;connected=false;motionStopped=false;stopBusy=false;++session;channel?.cancel('设备已断开');$('armed').checked=false;resetState();render();
  try {if(reader)await reader.cancel();if(readTask)await readTask;if(writer){await writer.ready;writer.releaseLock();writer=null;}if(port)await port.close();}
  catch(e){log('error','断开串口：'+e.message);}
  finally {port=null;reader=null;writer=null;readTask=null;channel=null;closing=false;log('info','连接已断开；硬件输出状态未作更改');render();}
}
$('disconnect').addEventListener('click',disconnect);
$('mode').addEventListener('change',()=>{$('armed').checked=false;resetState();render();});
$('armed').addEventListener('change',()=>{log('info',$('armed').checked?'硬件控制已启用':'硬件控制已禁用');render();});
async function run(command, success, readOnly=false, quiet=false) {
  if(!connected || connecting || closing || !channel || channel.halted || opBusy || recoveryBusy || (!readOnly && $('mode').value==='serial' && !$('armed').checked)){if(!quiet)toast('请先连接并启用控制，或等待当前操作结束');return false;}
  const current=channel, token=session;opBusy=true;render();
  try {await current.execute(command);if(token===session && !current.halted){success?.();if(!quiet)log('info','指令已确认');return true;}return false;}
  catch(e){if(token===session && !motionStopped){log('error',e.message);toast(e.message);resetState();$('armed').checked=false;}}
  finally{opBusy=false;render();}
}
async function queryEndstops(){
  if(!connected||connecting||closing||opBusy||recoveryBusy||!channel||channel.halted)return;
  const request={channel,token:session,entries:new Map()};endstopRequest=request;renderEndstops();$('endstop-status').textContent='正在读取 M119…';
  const ok=await run('M119',()=>{const entries=[...request.entries.values()];renderEndstops(entries);$('endstop-status').textContent=entries.length?`${$('mode').value==='demo'?'演示数据 · 非物理反馈':'控制器回报'} · ${new Date().toLocaleTimeString('zh-CN',{hour12:false})} · ${entries.length} 个输入`:'未收到有效限位状态，不能判定为未触发；请查看日志';},true);
  if(endstopRequest===request)endstopRequest=null;
  if(!ok && request.token===session){renderEndstops();$('endstop-status').textContent='检测未完成 · 状态未知，请查看日志';}
}
function motionCommand(key){ const base=config[key];Bench.lines(base);return base+'\nM400\n'+config.position; }
// ---- Keyboard jogging -------------------------------------------------------
// Arrows / WASD drive XY, PageUp-PageDown drives Z. Holding a key runs a stepping
// loop paced by controller acknowledgements, so a second move is never queued
// before the first one is confirmed. Releasing the key stops after the live step.
const KEY_JOG={ArrowLeft:['X',-1],ArrowRight:['X',1],ArrowUp:['Y',1],ArrowDown:['Y',-1],PageUp:['Z',1],PageDown:['Z',-1],a:['X',-1],d:['X',1],w:['Y',1],s:['Y',-1]};
let heldKey=null,keyJogBusy=false;
function jogReady(){return connected && !connecting && !closing && !opBusy && !recoveryBusy && !!channel && !channel.halted && !($('mode').value==='serial' && !$('armed').checked);}
function keyJogTarget(e){const k=e.key||'';return KEY_JOG[k]||KEY_JOG[k.toLowerCase()];}
function keyJogBlocked(e){
  if(e.ctrlKey||e.metaKey||e.altKey)return true;
  if(document.querySelector('dialog[open]'))return true;
  const t=e.target;
  return !!(t && t.closest && t.closest('input,textarea,select,[contenteditable]'));
}
async function stepJog(hold){
  const axis=hold.axis,step=axis==='Z'?zStep:xyStep,feed=Number($(axis==='Z'?'feed-z':'feed').value);
  let row;
  try {row=Bench.jog(config,axis,step*hold.sign,feed);}
  catch(err){toast(err.message);return false;}
  return run(row+'\nM400\n'+config.position,null,false,true);
}
async function driveKeyJog(){
  if(keyJogBusy)return;
  keyJogBusy=true;
  try{
    while(heldKey){
      if(requiresHome){toast('急停后请先全部回零');heldKey=null;break;}
      const hold=heldKey;
      if(!await stepJog(hold)){if(heldKey===hold)heldKey=null;break;}
      if(heldKey!==hold)break;
      await new Promise(r=>setTimeout(r,0));
    }
  } finally {keyJogBusy=false;}
}
document.addEventListener('keydown',e=>{
  const target=keyJogTarget(e);
  if(!target||keyJogBlocked(e))return;
  if(heldKey){e.preventDefault();return;}
  if(!jogReady())return;
  e.preventDefault();heldKey={axis:target[0],sign:target[1]};driveKeyJog();
});
document.addEventListener('keyup',e=>{
  const target=keyJogTarget(e);
  if(target&&heldKey&&heldKey.axis===target[0]&&heldKey.sign===target[1])heldKey=null;
});
window.addEventListener('blur',()=>{heldKey=null;});
// ---- Position presets -------------------------------------------------------
function currentCoordinates(){
  const p=lastPosition||{};
  return ['X','Y','Z'].every(a=>Number.isFinite(p[a]))?{x:p.X,y:p.Y,z:p.Z}:null;
}
function renderPresets(){
  const host=$('presets');host.replaceChildren();
  $('preset-count').textContent=prefs.presets.length?prefs.presets.length+' 个':'0 个';
  if(!prefs.presets.length){
    const empty=document.createElement('p');empty.className='note preset-empty';
    empty.textContent='还没有预设。先读取坐标，命名后保存，之后可一键前往。';
    host.append(empty);
  }
  prefs.presets.forEach((preset,index)=>{
    const row=document.createElement('div');row.className='preset-row';
    const name=document.createElement('input');name.className='preset-name';name.value=preset.name;name.maxLength=40;
    name.dataset.presetName=index;name.setAttribute('aria-label','预设名称');
    const coord=document.createElement('span');coord.className='preset-coord';
    coord.textContent=`X ${preset.x.toFixed(3)} · Y ${preset.y.toFixed(3)} · Z ${preset.z.toFixed(3)}`;
    const actions=document.createElement('div');actions.className='preset-actions';
    const go=document.createElement('button');go.textContent='前往';go.dataset.presetGoto=index;go.dataset.hardware='';
    const update=document.createElement('button');update.textContent='更新';update.dataset.presetUpdate=index;
    const remove=document.createElement('button');remove.textContent='删除';remove.dataset.presetDelete=index;remove.className='preset-remove';
    actions.append(go,update,remove);row.append(name,coord,actions);host.append(row);
  });
  render();
}
function savePreset(){
  const coords=currentCoordinates();
  if(!coords){toast('请先点「读取坐标」，读出 X / Y / Z 之后再保存预设');return;}
  const input=$('preset-name');
  const name=(input.value.trim()||'预设 '+(prefs.presets.length+1)).slice(0,40);
  const existing=prefs.presets.findIndex(p=>p.name===name);
  if(existing<0 && prefs.presets.length>=60){toast('预设最多保留 60 个，请先删除不用的');return;}
  if(existing>=0)prefs.presets[existing]={name,...coords};
  else prefs.presets.push({name,...coords});
  if(!savePreferences())return;
  input.value='';renderPresets();
  toast(existing>=0?`已覆盖预设「${name}」`:`已保存预设「${name}」`);
}
$('preset-save').addEventListener('click',savePreset);
$('preset-name').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();savePreset();}});
document.addEventListener('change',e=>{
  const index=e.target?.dataset?.presetName;
  if(index===undefined||!e.target.classList.contains('preset-name'))return;
  const preset=prefs.presets[Number(index)];if(!preset)return;
  const next=e.target.value.trim().slice(0,40);
  if(!next){e.target.value=preset.name;toast('预设名称不能为空');return;}
  if(next===preset.name)return;
  preset.name=next;savePreferences();
});
// ---- Macros -----------------------------------------------------------------
function expandMacro(text){
  const p=lastPosition||{};
  return String(text).replace(/\{(X|Y|Z|xyStep|zStep|feed|feedZ)\}/g,(whole,token)=>{
    if(token==='X'||token==='Y'||token==='Z'){
      if(!Number.isFinite(p[token]))throw Error(`宏需要当前 ${token} 坐标，请先读取坐标`);
      return p[token].toFixed(3);
    }
    if(token==='xyStep')return String(xyStep);
    if(token==='zStep')return String(zStep);
    return String($(token==='feed'?'feed':'feed-z').value);
  });
}
function renderMacros(){
  const host=$('macro-bar');host.replaceChildren();
  prefs.macros.forEach((macro,index)=>{
    const button=document.createElement('button');
    button.textContent=macro.name;button.title=macro.command;
    button.dataset.macro=index;button.dataset.hardware='';
    host.append(button);
  });
  render();
}
let draftMacros=null;
function macroForm(list){
  const host=$('macro-fields');host.replaceChildren();
  list.forEach((macro,index)=>{
    const row=document.createElement('div');row.className='macro-row';
    const name=document.createElement('input');name.className='macro-name';name.value=macro.name;name.maxLength=40;name.placeholder='宏名称';name.dataset.macroName=index;
    const command=document.createElement('textarea');command.className='macro-command';command.value=macro.command;command.rows=2;command.placeholder='例如 M115　或　G90\nG1 X{X} Y{Y} F1000';command.dataset.macroCommand=index;
    const remove=document.createElement('button');remove.type='button';remove.textContent='删除';remove.className='macro-remove';remove.dataset.macroRemove=index;
    row.append(name,command,remove);host.append(row);
  });
}
function readMacroDraft(){
  if(!draftMacros)return;
  document.querySelectorAll('[data-macro-name]').forEach(f=>{const m=draftMacros[Number(f.dataset.macroName)];if(m)m.name=f.value;});
  document.querySelectorAll('[data-macro-command]').forEach(f=>{const m=draftMacros[Number(f.dataset.macroCommand)];if(m)m.command=f.value;});
}
$('macros-open').addEventListener('click',()=>{draftMacros=prefs.macros.map(m=>({...m}));macroForm(draftMacros);$('macros').showModal();});
$('macros-close').addEventListener('click',()=>{draftMacros=null;$('macros').close();});
$('macro-add').addEventListener('click',()=>{
  if(!draftMacros)return;
  if(draftMacros.length>=60){toast('宏最多保留 60 个');return;}
  readMacroDraft();draftMacros.push({name:'',command:''});macroForm(draftMacros);
});
$('macro-reset').addEventListener('click',()=>{if(draftMacros){draftMacros=[];macroForm(draftMacros);}});
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.dataset.macroRemove===undefined||!draftMacros)return;
  readMacroDraft();draftMacros.splice(Number(b.dataset.macroRemove),1);macroForm(draftMacros);
});
$('macros-form').addEventListener('submit',e=>{
  e.preventDefault();
  if(!draftMacros)return;
  readMacroDraft();
  const total=draftMacros.length;
  prefs.macros=draftMacros.filter(m=>m.name.trim()&&m.command.trim());
  const dropped=total-prefs.macros.length;draftMacros=null;
  if(!savePreferences())return;
  renderMacros();$('macros').close();
  toast(dropped?`已保存 ${prefs.macros.length} 个宏；${dropped} 条因名称为空或指令为空被丢弃`:`已保存 ${prefs.macros.length} 个宏`);
});
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b || b.disabled)return;
  if(b.hasAttribute('data-endstops'))queryEndstops();
  else if(b.dataset.step) {
    const group=b.dataset.group, value=Number(b.dataset.step);
    if(group==='xy'){xyStep=value;$('xy-step-display').textContent=value;$('xy-step-foot').textContent=value+' mm';document.querySelectorAll('[data-ring]').forEach(r=>r.classList.toggle('selected-ring',Number(r.dataset.ring)===value));}else{zStep=value;$('z-step-foot').textContent=value+' mm';}
    document.querySelectorAll(`[data-group="${group}"]`).forEach(step=>{const selected=Number(step.dataset.step)===value;step.classList.toggle('selected',selected);step.setAttribute('aria-pressed',String(selected));});
    prefs[group==='xy'?'xyStep':'zStep']=value;savePreferences();
  } else if(b.dataset.nozzlePreset){const side=b.dataset.nozzlePreset;$(side+'-angle').value=b.dataset.angle;prefs[side+'Angle']=Number(b.dataset.angle);savePreferences();}
  else if(b.dataset.nozzle){
    try{if(requiresHome)throw Error('急停后请先全部回零');const side=b.dataset.nozzle,S=side==='left'?'Left':'Right',absolute=b.dataset.direction==='absolute';const angle=Number($(side+(absolute?'-target':'-angle')).value),feed=Number($(side+'-feed').value);if(!absolute && angle<=0)throw Error('每次转动角度必须大于 0');const sign=(b.dataset.direction==='cw'?1:-1)*(config['nozzle'+S+'CwPositive']?1:-1);run(Bench.rotate(config,S,absolute?angle:angle*sign,feed,absolute));}catch(err){toast(err.message);}
  } else if(b.dataset.axis) {
    try {if(requiresHome)throw Error('急停后请先全部回零');const axis=b.dataset.axis, step=axis==='Z'?zStep:xyStep, feed=Number($(axis==='Z'?'feed-z':'feed').value);const command=Bench.jog(config,axis,step*Number(b.dataset.sign),feed);run(command+'\nM400\n'+config.position);}
    catch(err){toast(err.message);}
  } else if(b.dataset.command) {
    try {const key=b.dataset.command;run(key.startsWith('home')?motionCommand(key):config[key],()=>{if(key==='homeAll'){requiresHome=false;$('position-source').textContent=$('position-source').textContent.replace(' · 需全部回零确认','');render();}});}
    catch(err){toast(err.message);}
  } else if(b.dataset.literal) run(b.dataset.literal);
  else if(b.dataset.output) {
    const key=b.dataset.output,on=b.dataset.value==='on';
    const actual=config.sharedLights && key.startsWith('light')?'lightTop':key;
    let command;
    try {command=on && key in prefs.strength?Bench.withStrength(config[actual+'On'],prefs.strength[key]):config[actual+(on?'On':'Off')];}
    catch(err){toast(err.message);return;}
    run(command,()=>{states[key]=on;if(config.sharedLights && key.startsWith('light'))states.lightTop=states.lightBottom=on;renderStates();});
  }
  else if(b.dataset.macro!==undefined) {
    const macro=prefs.macros[Number(b.dataset.macro)];
    if(!macro)return;
    let command;
    try {command=expandMacro(macro.command);}
    catch(err){toast(err.message);return;}
    run(command,()=>log('info','宏「'+macro.name+'」已执行'));
  }
  else if(b.dataset.presetGoto!==undefined) {
    try {
      if(requiresHome)throw Error('急停后请先全部回零');
      const preset=prefs.presets[Number(b.dataset.presetGoto)];
      if(!preset)throw Error('预设已不存在，请重新保存');
      run(Bench.goTo(config,preset.x,preset.y,preset.z,Number($('feed').value),Number($('feed-z').value)),()=>toast('已前往「'+preset.name+'」'));
    } catch(err){toast(err.message);}
  }
  else if(b.dataset.presetUpdate!==undefined) {
    const coords=currentCoordinates(),preset=prefs.presets[Number(b.dataset.presetUpdate)];
    if(!preset)return;
    if(!coords){toast('请先点「读取坐标」，再用当前坐标更新预设');return;}
    Object.assign(preset,coords);
    if(savePreferences()){renderPresets();toast('已用当前坐标更新「'+preset.name+'」');}
  }
  else if(b.dataset.presetDelete!==undefined) {
    const index=Number(b.dataset.presetDelete),preset=prefs.presets[index];
    if(!preset)return;
    prefs.presets.splice(index,1);
    if(savePreferences()){renderPresets();toast('已删除「'+preset.name+'」');}
  }
});
for(const on of [true,false])$('lights-'+(on?'on':'off')).addEventListener('click',()=>{
  try {const suffix=on?'On':'Off';Bench.lines(config['lightTop'+suffix]);if(!config.sharedLights)Bench.lines(config['lightBottom'+suffix]);const command=config['lightTop'+suffix]+(config.sharedLights?'':'\n'+config['lightBottom'+suffix]);run(command,()=>{states.lightTop=states.lightBottom=on;renderStates();});}catch(e){toast(e.message);}
});
$('command-form').addEventListener('submit',e=>{e.preventDefault();if(requiresHome){toast('急停后请先全部回零，再使用手动指令');return;}run($('manual-command').value,()=>{for(const [k]of outputs)states[k]=null;renderStates();$('manual-command').value='';});});
function canResume(){return !config.stopRaw && config.stop.trim().toUpperCase()==='M410';}
$('stop').addEventListener('click',async()=>{
  const current=channel;if(!current || closing || connecting){toast('当前没有可发送急停的连接；如需停止硬件请使用物理急停');return;}
  motionStopped=true;requiresHome=true;stopBusy=true;stopDelivered=false;current.cancel('软件急停');$('armed').checked=false;heldKey=null;
  lastPosition=null;for(const a of ['X','Y','Z'])$('pos-'+a).textContent='—';$('position-source').textContent='停止请求已发送，坐标需重新回零确认';
  for(const side of ['left','right'])$('nozzle-pos-'+side).textContent='—';
  render();log('error','软件急停：取消剩余指令，保持串口连接');
  const token=session, stopGeneration=current.cancellations;
  try{
    if(!config.stop.trim())throw Error('未配置急停指令；请使用物理急停');
    const ending={LF:'\n',CRLF:'\r\n',CR:'\r'}[config.newline];
    const data=config.stopRaw?Bench.raw(config.stop):Bench.lines(config.stop).join(ending)+ending;
    log('tx','优先停止 → '+config.stop);await current.write(data);
    if(token!==session || stopGeneration!==current.cancellations)return;
    stopDelivered=true;
    toast(canResume()?'停止请求已发送；串口保持连接，检查机器后可解除急停':'停止请求已发送；自定义停机指令可能需要复位主控');
    log('info',$('mode').value==='demo'?'演示运动已停止；连接保持':'停止指令已写入串口；请确认机器实际停止');
  }catch(e){log('error',e.message);toast(e.message);}
  finally{if(token===session && stopGeneration===current.cancellations){stopBusy=false;render();}}
});
$('resume-control').addEventListener('click',async()=>{
  if(!connected || !motionStopped || stopBusy || !stopDelivered || opBusy || recoveryBusy || !canResume())return;
  const current=channel,token=session;recoveryBusy=true;render();
  try{
    const marker='BENCH_SYNC_'+Date.now().toString(36).toUpperCase()+'_'+Math.random().toString(36).slice(2,9).toUpperCase();
    await current.synchronize(marker);
    await current.execute('G90\n'+config.position);
    if(token!==session || current.halted)return;
    motionStopped=false;
    $('armed').checked=$('mode').value==='serial';
    toast('已解除急停，连接保持；请先全部回零');log('info','同步完成，急停已解除；旧指令不重放，需全部回零');
  }catch(e){if(token===session){current.halted=true;log('error',e.message);toast(e.message);}}
  finally{recoveryBusy=false;render();}
});
$('clear-log').addEventListener('click',()=>{$('log').replaceChildren();logEntries.length=0;});
$('export-log').addEventListener('click',()=>download('lumenpnp-log-'+stamp()+'.txt',`LumenPnP Hardware Bench v2.0.0\n模式：${$('mode').value}\n`+logEntries.join('\n')));
// ---- Photon feeder bus ------------------------------------------------------
// Frames are addressed on a 1–254 bus with broadcast on 255. The panel mirrors the
// official Opulo tool's workflow but fixes two defects in it: the custom-packet
// form now reads its own fields, and the vendor option reply is decoded by payload
// instead of by absolute packet index.
const FEEDER_UNICAST = [
  ['GET_ID', '获取供料器 ID', false], ['INITIALIZE', '初始化供料器', true], ['GET_VERSION', '获取固件版本', false],
  ['MOVE_FEED_FORWARD', '向前进料', true], ['MOVE_FEED_BACKWARD', '向后进料', true],
  ['MOVE_FEED_STATUS', '读取进料状态', false], ['VENDOR_OPTIONS', '厂商选项（读固件串）', true]
];
const FEEDER_BROADCAST = [
  ['GET_FEEDER_ADDRESS', '获取供料器地址', true, false], ['IDENTIFY_FEEDER', '识别供料器（闪灯）', true, false],
  ['PROGRAM_FEEDER_FLOOR', '编程供料器地址', true, true], ['UNINITIALIZED_FEEDERS_RESPOND', '未初始化供料器响应', false, false]
];
let feederPacketID = 0, exchangeBusy = false, feederScanning = false, feederFound = [], tmcReportText = null, vacReportText = null;
function serialReady() {
  return connected && !connecting && !closing && !opBusy && !recoveryBusy && !!channel && !channel.halted && !motionStopped
    && ($('mode').value !== 'serial' || $('armed').checked);
}
function serialIdle() { return serialReady() && !exchangeBusy && !feederScanning; }
function feederNote(text, state) { const box = $('feeder-result'); box.textContent = text; box.className = 'feeder-result' + (state ? ' ' + state : ''); }
function describeFeederReply(reply) {
  if (!reply) return '无应答（rs485 TIMEOUT）';
  return `来源 ${hexByte(reply.from)} · 包 ID ${hexByte(reply.packetID)} · 载荷长度 ${hexByte(reply.length)} · 校验 ${hexByte(reply.checksum)} · 状态 ${hexByte(reply.state)}${reply.id ? ' · 载荷 ' + reply.id : ''}`;
}
async function feederExchange(command, address, payload) {
  if (!serialReady()) throw Error('请先连接、勾选「允许硬件控制」，并等待当前操作结束');
  const packetID = feederPacketID;
  const frame = Bench.feederFrame({ command, address, packetID, payload });
  const replies = [];
  const off = tapLines(line => { const parsed = Bench.feederReply(line); if (parsed) replies.push(parsed); });
  const current = channel, token = session;
  exchangeBusy = true; opBusy = true; render();
  try {
    await current.execute(frame.gcode);
    for (let i = 0; i < 10 && !replies.length; i++) await sleep(50);
    if (token !== session) throw Error('连接已变化，供料器操作已取消');
  } catch (e) {
    if (/unknown command/i.test(e.message)) throw Error('控制器不识别 M485：当前固件不是 Photon 版 Marlin，供料器总线不可用。请断开后重连（该错误会锁定通道）');
    throw e;
  } finally { off(); feederPacketID = packetID < 255 ? packetID + 1 : 0; exchangeBusy = false; opBusy = false; render(); }
  const reply = replies[0];
  if (!reply) throw Error('未收到供料器应答（缺少 rs485-reply）');
  if (reply.status === 'timeout') return null;
  if (reply.status === 'unsupported') throw Error('固件未启用 Photon 支持（应答为空）');
  if (reply.status === 'checksum') throw Error(`应答校验和错误：收到 ${hexByte(reply.checksum)}，计算得 ${hexByte(reply.computed)}`);
  if (reply.status === 'invalid') throw Error('应答无法解析：' + reply.message);
  if (reply.packetID !== packetID) throw Error(`应答包 ID ${hexByte(reply.packetID)} 与发出的 ${hexByte(packetID)} 不符，总线可能串包`);
  return reply;
}
function renderFeederFound() {
  const host = $('found-feeders'); host.replaceChildren();
  for (const item of feederFound) {
    const card = document.createElement('div'); card.className = 'found-feeder' + (item.ok ? '' : ' warn');
    const head = document.createElement('h3'); head.textContent = '#' + item.address;
    const id = document.createElement('h4'); id.textContent = item.id;
    const note = document.createElement('small'); note.textContent = item.ok ? '已初始化' : (item.reason || '初始化失败');
    const actions = document.createElement('div'); actions.className = 'feeder-card-actions';
    for (const [action, label] of [['identify', '识别'], ['feed', '进料'], ['firmware', '固件版本']]) {
      const b = document.createElement('button'); b.textContent = label;
      b.dataset.feederAction = action; b.dataset.feederAddress = String(item.address); b.dataset.hardware = '';
      actions.append(b);
    }
    card.append(head, id, note, actions); host.append(card);
  }
  render();
}
async function scanFeeders() {
  if (!serialIdle()) { toast('请先连接并启用硬件控制'); return; }
  feederScanning = true; feederFound = []; renderFeederFound();
  $('feeder-scan').textContent = '扫描中…';
  let failure = null;
  try {
    for (let address = 1; address <= Bench.FEEDER_SLOTS; address++) {
      $('feeder-status').textContent = `扫描中 · ${address}/${Bench.FEEDER_SLOTS}${feederFound.length ? ` · 已找到 ${feederFound.length}` : ''}`;
      let identify;
      try { identify = await feederExchange('GET_ID', address); }
      catch (e) { failure = e; break; }
      if (!identify || identify.state !== 0) continue;
      let init = null, initError = null;
      try { init = await feederExchange('INITIALIZE', address, identify.payload); }
      catch (e) { initError = e; }
      feederFound.push({ address, id: identify.id, ok: !initError && !!init && init.state === 0, reason: initError && initError.message });
      renderFeederFound();
      if (initError) { failure = initError; break; }
    }
  } finally { feederScanning = false; $('feeder-scan').textContent = '扫描供料器'; }
  if (failure) { $('feeder-status').textContent = '扫描中断 · ' + failure.message; log('error', '供料器扫描中断：' + failure.message); toast(failure.message); }
  else {
    $('feeder-status').textContent = feederFound.length
      ? `已找到 ${feederFound.length} 个供料器 · ${new Date().toLocaleTimeString('zh-CN', { hour12:false })}`
      : `1–${Bench.FEEDER_SLOTS} 号位均无应答`;
    log('info', `供料器扫描完成：${feederFound.length} 个应答`);
  }
  renderFeederFound();
}
async function feederFirmware(address) {
  const chunks = [];
  for (let option = 0; option < 16; option++) {
    $('feeder-status').textContent = `读取 #${address} 固件字符串 · 第 ${option + 1}/16 段`;
    const reply = await feederExchange('VENDOR_OPTIONS', address, [option]);
    if (!reply || reply.state !== 0) break;
    const text = String.fromCharCode(...reply.payload).replace(/\u0000/g, '');
    if (!text.trim()) break;
    chunks.push(text);
  }
  return chunks.join('').trim();
}
async function feederAction(action, address) {
  if (!serialIdle()) { toast('请先连接并启用硬件控制'); return; }
  const item = feederFound.find(f => f.address === address);
  try {
    if (action === 'identify') {
      const reply = await feederExchange('IDENTIFY_FEEDER', Bench.FEEDER_BROADCAST, Bench.parseHex(item ? item.id : ''));
      feederNote(`#${address} 识别指令已发送 · ${describeFeederReply(reply)}`, 'ok');
    } else if (action === 'feed') {
      const reply = await feederExchange('MOVE_FEED_FORWARD', address, [Bench.FEEDER_FEED_STEP]);
      feederNote(`#${address} 进料一步 · ${describeFeederReply(reply)}`, 'ok');
    } else {
      const version = await feederFirmware(address);
      feederNote(`#${address} 固件字符串：${version || '（未返回内容，固件可能为 1.3 或更早）'}`, version ? 'ok' : 'error');
      $('feeder-status').textContent = version ? `#${address} 固件 ${version}` : `#${address} 未返回固件字符串`;
    }
  } catch (e) { feederNote(e.message, 'error'); toast(e.message); log('error', '供料器操作失败：' + e.message); }
}
async function sendUnicast() {
  if (!serialIdle()) { toast('请先连接并启用硬件控制'); return; }
  const name = $('uni-command').value, spec = FEEDER_UNICAST.find(c => c[0] === name);
  try {
    const payload = spec[2] ? Bench.parseHex($('uni-payload').value) : [];
    const reply = await feederExchange(name, Number($('uni-address').value), payload);
    feederNote(`单播 ${name} → ${describeFeederReply(reply)}`, reply ? 'ok' : 'error');
  } catch (e) { feederNote(e.message, 'error'); toast(e.message); }
}
async function sendBroadcast() {
  if (!serialIdle()) { toast('请先连接并启用硬件控制'); return; }
  const name = $('broad-command').value, spec = FEEDER_BROADCAST.find(c => c[0] === name);
  try {
    let payload = spec[2] ? Bench.parseHex($('broad-uuid').value) : [];
    if (spec[3]) payload = payload.concat([Number($('broad-address').value)]);
    const reply = await feederExchange(name, Bench.FEEDER_BROADCAST, payload);
    feederNote(`广播 ${name} → ${describeFeederReply(reply)}`, reply ? 'ok' : 'error');
  } catch (e) { feederNote(e.message, 'error'); toast(e.message); }
}
async function sendCustomPacket() {
  if (!serialIdle()) { toast('请先连接并启用硬件控制'); return; }
  try {
    const command = Number($('custom-command').value);
    if (!Number.isInteger(command) || command < 0 || command > 255) throw Error('指令码必须是 0–255 的整数');
    const reply = await feederExchange(command, Number($('custom-address').value), Bench.parseHex($('custom-payload').value));
    feederNote(`自定义指令码 ${command} → ${describeFeederReply(reply)}`, reply ? 'ok' : 'error');
  } catch (e) { feederNote(e.message, 'error'); toast(e.message); }
}
function calcFeederChecksum() {
  try {
    const fields = ['calc-to', 'calc-from', 'calc-packet', 'calc-length', 'calc-command'].map(id => Number($(id).value));
    if (!fields.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw Error('校验和工具的各字段必须是 0–255 的整数');
    const payload = Bench.parseHex($('calc-payload').value);
    const bytes = [...fields, ...payload];
    const checksum = Bench.feederChecksum(bytes);
    const mismatch = fields[3] - 1 !== payload.length ? ` · 注意：载荷长度声明为 ${fields[3]}，实际载荷 ${payload.length} 字节` : '';
    $('calc-result').textContent = `校验和 ${hexByte(checksum)} · 整帧 M485 ${Bench.toHex([...bytes.slice(0, 4), checksum, ...bytes.slice(4)])}${mismatch}`;
  } catch (e) { $('calc-result').textContent = e.message; }
}
async function locateSlotFifty() {
  if (!serialIdle()) { toast('请先连接并启用硬件控制'); return; }
  try {
    $('feeder-status').textContent = '正在查询 50 号位…';
    const found = await feederExchange('GET_ID', 50);
    if (!found || found.state !== 0) { feederNote('50 号位无应答，无法定位', 'error'); $('feeder-status').textContent = '50 号位无应答'; return; }
    const reply = await feederExchange('IDENTIFY_FEEDER', Bench.FEEDER_BROADCAST, found.payload);
    feederNote(`已让 50 号位供料器接收识别指令 · ID ${found.id}${reply ? ' · 状态 ' + hexByte(reply.state) : ''}`, 'ok');
    $('feeder-status').textContent = '50 号位供料器已接收识别指令';
  } catch (e) { feederNote(e.message, 'error'); toast(e.message); }
}
// Slot programmer. A promise-based dialog replaces the official tool's blocking
// modal so the flow stays cancellable and never freezes the page.
let wizardAsk = null;
function askFeederQuestion({ title, step, message, input }) {
  return new Promise(resolve => {
    $('wizard-title').textContent = title;
    $('wizard-step').textContent = '第 ' + step + ' 步';
    $('wizard-message').textContent = message;
    $('wizard-input-label').hidden = !input;
    wizardAsk = resolve;
    $('feeder-wizard').showModal();
    if (input) $('wizard-input').select();
  });
}
function answerWizard(value) { const resolve = wizardAsk; wizardAsk = null; $('feeder-wizard').close(); if (resolve) resolve(value); }
$('feeder-wizard-form').addEventListener('submit', e => { e.preventDefault(); answerWizard($('wizard-input-label').hidden ? true : Number($('wizard-input').value)); });
$('wizard-cancel').addEventListener('click', () => answerWizard(false));
$('feeder-wizard').addEventListener('cancel', e => { e.preventDefault(); answerWizard(false); });
async function programSlots() {
  if (!serialIdle()) { toast('请先连接并启用硬件控制'); return; }
  $('feeder-status').textContent = '编程卡位向导进行中';
  if (!await askFeederQuestion({ title: '开始之前', step: 1, input: false,
    message: '编程前请先从机器上取下所有 Photon 供料器。完成后点击确定继续，随时可以取消退出。' })) return;
  while (true) {
    const address = await askFeederQuestion({ title: '插入供料器', step: 2, input: true,
      message: '把要编程的供料器插到目标卡位，在下方填入要写入的地址（1–254），然后点击确定。' });
    if (!address) break;
    if (!Number.isInteger(address) || address < 1 || address > 254) { toast('地址必须是 1–254 的整数'); continue; }
    try {
      const blank = await feederExchange('UNINITIALIZED_FEEDERS_RESPOND', Bench.FEEDER_BROADCAST);
      if (!blank || blank.state !== 0) {
        if (!await askFeederQuestion({ title: '未检测到供料器', step: 2, input: false,
          message: '没有检测到未初始化的供料器。确认供料器已插入并上电后点击确定重试，或取消退出。' })) break;
        continue;
      }
      await feederExchange('PROGRAM_FEEDER_FLOOR', Bench.FEEDER_BROADCAST, blank.payload.concat([address]));
      const check = await feederExchange('GET_FEEDER_ADDRESS', Bench.FEEDER_BROADCAST, blank.payload);
      if (check && check.from === address) {
        log('info', `供料器 ${blank.id} 已编程为地址 ${address}`);
        if (!await askFeederQuestion({ title: '编程成功', step: 3, input: false,
          message: `卡位已写入地址 ${address}（ID ${blank.id}）。请取下该供料器，再点击确定继续编程下一个。` })) break;
      } else {
        log('error', `供料器 ${blank.id} 编程地址 ${address} 校验失败`);
        if (!await askFeederQuestion({ title: '编程失败', step: 3, input: false,
          message: `地址 ${address} 校验未通过${check ? `（读回 ${check.from}）` : '（无应答）'}。点击确定重试，或取消退出。` })) break;
      }
    } catch (e) {
      log('error', '编程卡位：' + e.message);
      if (!await askFeederQuestion({ title: '通信失败', step: 2, input: false, message: e.message + ' 点击确定重试，或取消退出。' })) break;
    }
  }
  $('feeder-status').textContent = '编程向导已结束';
}
// ---- Hardware self-test -----------------------------------------------------
async function hardwareAction(fn) {
  if (!serialIdle()) { toast('请先连接、勾选「允许硬件控制」，并等待当前操作结束'); return false; }
  opBusy = true; render();
  try { await fn(); return true; }
  catch (e) { log('error', e.message); toast(e.message); return false; }
  finally { opBusy = false; render(); }
}
// Marlin has no explicit end marker for M122 beyond `ok`, so wait until the line
// stream has been quiet for a moment instead of guessing a fixed delay.
async function collectUntilQuiet(captured, quietMs = 400, maxMs = 7000) {
  let last = Date.now(), count = captured.length; const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(100);
    if (captured.length !== count) { count = captured.length; last = Date.now(); }
    else if (Date.now() - last >= quietMs) return;
  }
}
async function runTmcTest() {
  await hardwareAction(async () => {
    const captured = []; const off = tapLines(line => captured.push(line));
    $('tmc-output').textContent = '正在采集 M122 报告…';
    try {
      await channel.execute('M122');
      await collectUntilQuiet(captured);
      const rows = captured.filter(l => l.trim() && l.trim() !== 'ok');
      tmcReportText = rows.length ? rows.join('\n') : null;
      $('tmc-output').textContent = tmcReportText || '（未收到任何报告行，请确认控制器支持 M122）';
      $('tmc-download').disabled = !rows.length;
      log('info', `TMC 驱动报告已采集 ${rows.length} 行`);
      if (rows.length) toast(`已采集 ${rows.length} 行 TMC 报告`); else throw Error('未收到 M122 报告；请确认控制器支持该指令');
    } catch (e) { tmcReportText = null; $('tmc-download').disabled = true; $('tmc-output').textContent = e.message; throw e; }
    finally { off(); }
  });
}
async function readVacuumByte(current, register) {
  let value = null;
  const off = tapLines(line => { if (value === null) { const b = Bench.dataByte(line); if (b !== null) value = b; } });
  try {
    await current.execute(Bench.vacuumAddress(register) + '\n' + Bench.VACUUM.readCommand);
    for (let i = 0; i < 12 && value === null; i++) await sleep(50);
  } finally { off(); }
  return value;
}
async function readVacuumSide(current, side) {
  const label = side === 'left' ? 'Left' : 'Right';
  await current.execute(Bench.vacuumSelect(side));
  const rows = [], bytes = [];
  for (const register of Bench.VACUUM.registers) {
    const b = await readVacuumByte(current, register);
    if (b === null) throw Error(`${side === 'left' ? '左' : '右'}侧寄存器 ${register} 无 data 应答`);
    bytes.push(b);
    rows.push(`${label} ${['MSB', 'CSB', 'LSB'][bytes.length - 1]} - ${b.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  const value = Bench.vacuumValue(...bytes);
  rows.push(`${label} Val - ${value}`);
  return { rows, value };
}
async function runVacuum(sides) {
  await hardwareAction(async () => {
    const current = channel;
    const rows = []; const failures = [];
    for (const side of sides) {
      $('vac-output').textContent = `正在读取${side === 'left' ? '左' : '右'}侧…`;
      try {
        const { rows: sideRows, value } = await readVacuumSide(current, side);
        rows.push(...sideRows);
        $('vac-value-' + side).textContent = String(value);
      } catch (e) { failures.push(e.message); rows.push(`${side === 'left' ? 'Left' : 'Right'} ERROR - ${e.message}`); }
    }
    vacReportText = rows.length ? rows.join('\n') : null;
    $('vac-output').textContent = vacReportText || '（未读取到数据）';
    $('vac-download').disabled = !rows.length;
    if (failures.length) throw Error(failures.join('；'));
    log('info', `真空传感器读取完成：${rows.filter(r => r.includes('Val')).join('，')}`);
    toast('真空读数已更新');
  });
}
async function sendVacuumBoot() {
  await hardwareAction(async () => {
    await channel.execute(Bench.vacuumBoot().join('\n'));
    $('vac-output').textContent = `官方启动序列已发送（${Bench.vacuumBoot().length} 条指令，全部得到确认）。\n该序列会写 I2C 寄存器，用于让真空传感器与照明进入官方工具的初始状态。`;
    log('info', '已发送官方真空 / 照明启动序列');
    toast('启动序列已发送');
  });
}
for (const [value, label] of FEEDER_UNICAST.map(c => [c[0], c[1]])) $('uni-command').add(new Option(label, value));
for (const [value, label] of FEEDER_BROADCAST.map(c => [c[0], c[1]])) $('broad-command').add(new Option(label, value));
function syncFeederForms() {
  const uni = FEEDER_UNICAST.find(c => c[0] === $('uni-command').value);
  const broad = FEEDER_BROADCAST.find(c => c[0] === $('broad-command').value);
  $('uni-payload-label').hidden = !uni[2];
  $('broad-address-label').hidden = !broad[3];
}
$('uni-command').addEventListener('change', syncFeederForms);
$('broad-command').addEventListener('change', syncFeederForms);
syncFeederForms();
$('feeder-scan').addEventListener('click', scanFeeders);
$('feeder-program').addEventListener('click', programSlots);
$('feeder-flash').addEventListener('click', locateSlotFifty);
$('uni-send').addEventListener('click', sendUnicast);
$('broad-send').addEventListener('click', sendBroadcast);
$('custom-send').addEventListener('click', sendCustomPacket);
$('calc-run').addEventListener('click', calcFeederChecksum);
$('tmc-run').addEventListener('click', runTmcTest);
$('vac-left').addEventListener('click', () => runVacuum(['left']));
$('vac-right').addEventListener('click', () => runVacuum(['right']));
$('vac-both').addEventListener('click', () => runVacuum(['left', 'right']));
$('vac-boot').addEventListener('click', sendVacuumBoot);
$('tmc-download').addEventListener('click', () => { if (tmcReportText) download('lumenpnp-tmc-' + stamp() + '.txt', `LumenPnP 硬件调试台 v2.0.0\n步进驱动（TMC）检测报告\n${new Date().toLocaleString('zh-CN')}\n模式：${$('mode').value}\n\n` + tmcReportText); });
$('vac-download').addEventListener('click', () => { if (vacReportText) download('lumenpnp-vac-' + stamp() + '.txt', `LumenPnP 硬件调试台 v2.0.0\n真空传感器报告\n${new Date().toLocaleString('zh-CN')}\n模式：${$('mode').value}\n\n` + vacReportText); });
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled || !b.dataset.feederAction || b.dataset.feederAddress === undefined) return;
  feederAction(b.dataset.feederAction, Number(b.dataset.feederAddress));
});
// Configuration editor. Saving and importing never execute hardware commands.
const configLabels={baud:'波特率',timeout:'每条指令响应超时（ms）',settle:'连接启动等待（ms）',newline:'行结束符（LF / CRLF / CR）',ack:'确认响应正则',error:'错误响应正则',jog:'点动模板 · {axis} {distance} {feed}',homeX:'X 单轴回零',homeY:'Y 单轴回零',homeZ:'Z 单轴回零',homeAll:'全部回零',motorOff:'关闭电机',position:'查询坐标',stop:'软件急停指令',stopRaw:'急停使用原始字符（支持 \\xHH，不追加换行）',sharedLights:'上下灯共用顶部灯指令（官方部分版本为联动）',nozzleLeftAxis:'左吸嘴轴（A / B）',nozzleRightAxis:'右吸嘴轴（A / B）',nozzleLeftCwPositive:'左吸嘴顺时针对应正方向（取消则反向）',nozzleRightCwPositive:'右吸嘴顺时针对应正方向（取消则反向）'};
for(const [key,title]of outputs){configLabels[key+'On']=title+' · 开';configLabels[key+'Off']=title+' · 关';}
function configForm(c) {
  $('config-fields').replaceChildren();
  for(const [key,label]of Object.entries(configLabels)){
    const wrapper=document.createElement('label');wrapper.textContent=label;
    const field=document.createElement(typeof c[key]==='string'&&!['ack','error','newline'].includes(key)?'textarea':'input');field.dataset.config=key;
    if(typeof c[key]==='boolean'){field.type='checkbox';field.checked=c[key];wrapper.className='check wide';}
    else {field.value=c[key];if(typeof c[key]==='number')field.type='number';}
    if(key==='jog')wrapper.className='wide';wrapper.append(field);$('config-fields').append(wrapper);
  }
}
function readConfigForm(){const c={...config};document.querySelectorAll('[data-config]').forEach(f=>{const k=f.dataset.config;c[k]=typeof Bench.DEFAULTS[k]==='boolean'?f.checked:typeof Bench.DEFAULTS[k]==='number'?Number(f.value):f.value;});return Bench.validate(c);}
function installConfig(next){
  config=Bench.validate(next);for(const side of ['left','right'])$('nozzle-axis-'+side).textContent=config['nozzle'+(side==='left'?'Left':'Right')+'Axis'];try{localStorage.setItem('lumen-bench-config',JSON.stringify(config));}catch{toast('配置已应用，但浏览器无法保存；请导出 JSON 备份');}
  if(![...$('baud').options].some(o=>Number(o.value)===config.baud))$('baud').add(new Option(config.baud,config.baud));$('baud').value=config.baud;resetState();
}
$('settings-open').addEventListener('click',()=>{pendingImport=null;configForm(config);const locked=connected||connecting||closing;$('settings-form').querySelectorAll('input,textarea,button[type="submit"],#config-reset,#config-import').forEach(f=>f.disabled=locked);$('settings').showModal();if(locked)toast('设备已连接；可以查看和导出配置，修改前请断开');});
$('settings-close').addEventListener('click',()=>$('settings').close());
$('settings-form').addEventListener('submit',e=>{e.preventDefault();if(connected||connecting||closing)return;try{installConfig(readConfigForm());if(pendingImport){for(const key of ['top','bottom'])stopCamera(key);applyPreferences(pendingImport.preferences);renderPresets();renderMacros();applyTheme(pendingImport.theme);localStorage.setItem('lumen-bench-theme',pendingImport.theme);pendingImport=null;}const saved=savePreferences();$('settings').close();render();toast(saved?'全部设置已保存':'保存失败，请导出全部设置备份');}catch(e){toast(e.message);}});
$('config-reset').addEventListener('click',()=>{if(!connected){pendingImport=null;configForm({...Bench.DEFAULTS});}});
$('config-export').addEventListener('click',()=>{try{const bundle={type:'lumen-bench-settings',version:1,config:readConfigForm(),preferences:pendingImport?.preferences||Bench.preferences(prefs),theme:pendingImport?.theme||document.documentElement.dataset.theme};download('lumenpnp-settings-'+stamp()+'.json',JSON.stringify(bundle,null,2),'application/json');}catch(e){toast(e.message);}});
$('config-import').addEventListener('change',async e=>{const file=e.target.files[0];try{if(connected||connecting||closing)throw Error('请先断开设备');if(!file)return;if(file.size>65536)throw Error('配置文件过大');const data=JSON.parse(await file.text());if(data.type==='lumen-bench-settings'){if(data.version!==1 || !data.preferences || !['light','dark'].includes(data.theme))throw Error('全部设置文件格式无效');configForm(Bench.validate(data.config));pendingImport={preferences:Bench.preferences(data.preferences),theme:data.theme};}else{configForm(Bench.validate(data));pendingImport=null;}toast('设置已载入编辑区，请检查后保存');}catch(err){toast(err.message);}finally{e.target.value='';}});
// Two independent USB camera streams; browser permission is requested only on click.
for(const [key,title,code]of [['top','上摄像头 · PCB 视角','TOP / DOWNWARD'],['bottom','下摄像头 · 吸嘴视角','BOTTOM / UPWARD']]){
  cameraSlots[key]={stream:null,token:0};const box=document.createElement('div');box.className='camera';
  box.innerHTML=`<div class="camera-title">${title}<small>USB CAMERA</small></div><div id="frame-${key}" class="camera-frame"><video id="video-${key}" autoplay muted playsinline></video><div id="placeholder-${key}" class="placeholder"><span>⌾</span>等待摄像头连接</div><div id="cross-${key}" class="crosshair"></div><div class="frame-label">${code}</div></div><div class="camera-controls"><select id="device-${key}" aria-label="${title}设备"><option value="">先授权 / 刷新摄像头</option></select><button id="camera-start-${key}">开启</button><button id="camera-stop-${key}">关闭</button><button id="snapshot-${key}">截图</button><label class="camera-rotation">旋转 °<input id="rotation-${key}" type="number" min="-360" max="360" step="1" value="0" aria-label="${title}旋转角度"></label><label class="check"><input type="checkbox" id="mirror-${key}">镜像</label><label class="check"><input type="checkbox" id="cross-toggle-${key}" checked>十字线</label></div><div class="camera-status" id="camera-status-${key}">未开启 · 可同时显示两路画面</div>`;
  $('cameras').append(box);
  $('camera-start-'+key).addEventListener('click',()=>startCamera(key));
  $('camera-stop-'+key).addEventListener('click',()=>stopCamera(key));
  $('mirror-'+key).addEventListener('change',()=>{prefs[key+'Mirror']=$('mirror-'+key).checked;applyCameraView(key);savePreferences();});
  $('cross-toggle-'+key).addEventListener('change',()=>{prefs[key+'Cross']=$('cross-toggle-'+key).checked;applyCameraView(key);savePreferences();});
  $('rotation-'+key).addEventListener('input',()=>{const f=$('rotation-'+key);if(f.value.trim() && f.validity.valid){prefs[key+'Rotation']=Number(f.value);applyCameraView(key);savePreferences();}});
  $('device-'+key).addEventListener('change',()=>{const f=$('device-'+key);prefs[key+'Device']=f.value;prefs[key+'DeviceLabel']=f.selectedOptions[0]?.textContent||'';savePreferences();});
  $('video-'+key).addEventListener('loadedmetadata',()=>applyCameraView(key));
  new ResizeObserver(()=>applyCameraView(key)).observe($('frame-'+key));
  $('snapshot-'+key).addEventListener('click',()=>{
    const v=$('video-'+key);if(!v.videoWidth || !cameraSlots[key].stream){toast('请先开启摄像头');return;}
    const angle=prefs[key+'Rotation'],bounds=Bench.imageBounds(v.videoWidth,v.videoHeight,angle);
    const canvas=document.createElement('canvas');canvas.width=bounds.width;canvas.height=bounds.height;const ctx=canvas.getContext('2d');
    ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(angle*Math.PI/180);if(prefs[key+'Mirror'])ctx.scale(-1,1);ctx.drawImage(v,-v.videoWidth/2,-v.videoHeight/2);ctx.setTransform(1,0,0,1,0,0);
    if($('cross-toggle-'+key).checked){ctx.strokeStyle='#49d6b2';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(canvas.width/2,0);ctx.lineTo(canvas.width/2,canvas.height);ctx.moveTo(0,canvas.height/2);ctx.lineTo(canvas.width,canvas.height/2);ctx.stroke();}
    canvas.toBlob(blob=>{if(blob)download('lumenpnp-'+key+'-'+stamp()+'.png',blob,'image/png');},'image/png');
  });
}
function stopCamera(key){const slot=cameraSlots[key];++slot.token;slot.stream?.getTracks().forEach(t=>t.stop());slot.stream=null;$('video-'+key).srcObject=null;$('placeholder-'+key).hidden=false;$('camera-status-'+key).textContent='摄像头已关闭';$('camera-start-'+key).disabled=false;}
function applyCameraView(key){
  const v=$('video-'+key),frame=$('frame-'+key);if(!v || !frame)return;
  const angle=prefs[key+'Rotation'],w=v.videoWidth||1280,h=v.videoHeight||720,b=Bench.imageBounds(w,h,angle);
  const fit=Math.min(frame.clientWidth/b.width,frame.clientHeight/b.height);
  v.style.width=(w*fit)+'px';v.style.height=(h*fit)+'px';v.style.left='50%';v.style.top='50%';
  v.style.transform=`translate(-50%,-50%) rotate(${angle}deg) scaleX(${prefs[key+'Mirror']?-1:1})`;
  $('cross-'+key).hidden=!prefs[key+'Cross'];
}
let cameraScanGeneration=0,cameraRefreshBusy=false;
async function cameraList(authorize=false){
  const generation=++cameraScanGeneration;
  if(!navigator.mediaDevices?.enumerateDevices)throw Error('摄像头 API 不可用，请用桌面 Chrome / Edge 通过 localhost 或 HTTPS 打开');
  const result=await Bench.discoverCameras(navigator.mediaDevices,authorize);
  if(generation!==cameraScanGeneration)return result;
  const {devices,hiddenCount,authorizationError}=result;
  for(const key of ['top','bottom']){
    const select=$('device-'+key),saved=prefs[key+'Device'],label=prefs[key+'DeviceLabel'];select.replaceChildren();
    devices.forEach((d,i)=>select.add(new Option(d.label||'摄像头 '+(i+1),d.deviceId)));
    const sameName=label?devices.filter(d=>d.label===label):[];
    const match=devices.find(d=>d.deviceId===saved)||(sameName.length===1?sameName[0]:null);
    if(match){select.value=match.deviceId;prefs[key+'Device']=match.deviceId;prefs[key+'DeviceLabel']=match.label||label;}
    else if(saved){select.add(new Option((label||'已保存的摄像头')+' · 未找到 / 未授权',saved));select.value=saved;}
    else if(devices.length){select.selectedIndex=key==='bottom'&&devices.length>1?1:0;prefs[key+'Device']=select.value;prefs[key+'DeviceLabel']=devices[select.selectedIndex].label;}
    else select.add(new Option('先授权 / 刷新摄像头',''));
  }
  let permission='未知';
  try{permission=(await navigator.permissions.query({name:'camera'})).state;}catch{}
  if(generation!==cameraScanGeneration)return result;
  const detail=devices.map((d,i)=>`${i+1}. ${d.label||'未授权名称'} [${d.deviceId.slice(0,12)}…]`).join('；');
  const warning=authorizationError?`；授权 / 打开失败：${authorizationError.name}，检查站点权限或摄像头占用`:devices.length<2?'；仅少于 2 个设备，请检查浏览器和 Windows 摄像头权限':'';
  $('camera-discovery').textContent=`浏览器可选择 ${devices.length} 个摄像头 · 权限 ${permission}${hiddenCount?` · ${hiddenCount} 个设备未提供 ID`:''}${warning}`;
  log(authorizationError?'error':'info',`摄像头枚举：${devices.length} 个可选择，${hiddenCount} 个无 ID，权限 ${permission}${detail?'；'+detail:''}${authorizationError?`；${authorizationError.name}: ${authorizationError.message}`:''}`);
  savePreferences();
  return result;
}
$('camera-refresh').addEventListener('click',async()=>{
  cameraRefreshBusy=true;$('camera-refresh').disabled=true;
  try{const active=Object.values(cameraSlots).some(s=>s.stream?.active);const result=await cameraList(!active);toast(result.authorizationError?'授权 / 打开失败，已继续刷新可见设备；请查看日志':`已刷新：${result.devices.length} 个摄像头`);}
  catch(e){$('camera-discovery').textContent='摄像头列表刷新失败：'+e.message;toast('摄像头：'+e.message);log('error','摄像头列表刷新失败：'+e.message);}finally{cameraRefreshBusy=false;$('camera-refresh').disabled=false;}
});
let cameraDeviceTimer;
navigator.mediaDevices?.addEventListener('devicechange',()=>{
  clearTimeout(cameraDeviceTimer);cameraDeviceTimer=setTimeout(()=>{if(!cameraRefreshBusy)cameraList().catch(e=>log('error','设备变化刷新失败：'+e.message));},300);
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!cameraRefreshBusy)cameraList().catch(e=>log('error','摄像头刷新失败：'+e.message));});
async function startCamera(key){
  stopCamera(key);const slot=cameraSlots[key],token=slot.token;$('camera-start-'+key).disabled=true;$('camera-status-'+key).textContent='正在打开摄像头…';
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw Error('请通过 localhost 或 HTTPS 打开');
    const device=$('device-'+key).value;const other=cameraSlots[key==='top'?'bottom':'top'].stream?.getVideoTracks()[0]?.getSettings().deviceId;
    if(device && other===device)throw Error('该设备已用于另一路画面，请选择另一摄像头');
    const stream=await navigator.mediaDevices.getUserMedia({video:{...(device?{deviceId:{exact:device}}:{}),width:{ideal:1280},height:{ideal:720}},audio:false});
    if(token!==slot.token){stream.getTracks().forEach(t=>t.stop());return;}
    if(other && stream.getVideoTracks()[0]?.getSettings().deviceId===other){stream.getTracks().forEach(t=>t.stop());throw Error('选中了另一路正在使用的设备，请先刷新列表并选择另一摄像头');}
    slot.stream=stream;const v=$('video-'+key);v.srcObject=stream;await v.play();
    if(token!==slot.token)return;
    $('placeholder-'+key).hidden=true;const track=stream.getVideoTracks()[0],settings=track.getSettings();$('camera-status-'+key).textContent=`${settings.width} × ${settings.height} · ${track.label}`;
    track.addEventListener('ended',()=>{if(token===slot.token){stopCamera(key);$('camera-status-'+key).textContent='摄像头已中断，请检查 USB 连接';}});
    prefs[key+'Device']=settings.deviceId||device;prefs[key+'DeviceLabel']=track.label;applyCameraView(key);await cameraList();savePreferences();
  }catch(e){if(token===slot.token){stopCamera(key);$('camera-status-'+key).textContent='打开失败：'+e.message;toast('摄像头打开失败：'+e.message);}}
  finally{if(token===slot.token)$('camera-start-'+key).disabled=false;}
}
window.addEventListener('beforeunload',()=>{channel?.cancel();for(const key of ['top','bottom'])cameraSlots[key].stream?.getTracks().forEach(t=>t.stop());});
installConfig(config);applyPreferences(prefs);renderPresets();renderMacros();render();
for(const [id,key]of [['feed','feed'],['feed-z','feedZ'],['left-angle','leftAngle'],['right-angle','rightAngle'],['left-target','leftTarget'],['right-target','rightTarget'],['left-feed','leftFeed'],['right-feed','rightFeed']])$(id).addEventListener('input',()=>{const f=$(id);if(f.value.trim() && f.validity.valid){prefs[key]=Number(f.value);savePreferences();}});
$('mode').addEventListener('change',()=>{prefs.mode=$('mode').value;savePreferences();});
$('baud').addEventListener('change',()=>{config.baud=Number($('baud').value);savePreferences();});
if(navigator.mediaDevices?.enumerateDevices)cameraList().catch(e=>{$('camera-discovery').textContent='摄像头枚举失败：'+e.message;log('error',e.message);});
else $('camera-discovery').textContent='摄像头 API 不可用，请用桌面 Chrome / Edge 打开 localhost 页面';
log('info','调试台已就绪 · 已加载保存的设置 · 请先连接');
