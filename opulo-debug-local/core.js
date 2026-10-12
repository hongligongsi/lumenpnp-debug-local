/* OpenPnP Hardware Bench v1.6.0 — standalone, dependency-free protocol engine. */
(function (root) {
  'use strict';
  const DEFAULTS = {
    version: 2, baud: 115200, timeout: 30000, settle: 2000, newline: 'LF',
    ack: '^ok\\b', error: '^(error|alarm|!!|echo:Unknown command|Resend:)',
    jog: 'G21\nG91\nG1 {axis}{distance} F{feed}\nG90',
    homeX: 'G28 X', homeY: 'G28 Y', homeZ: 'G28 Z', homeAll: 'G28',
    motorOff: 'M18', position: 'M114', stop: 'M410', stopRaw: false, sharedLights: true,
    lightTopOn: 'M150 P45 R255 U255 B255', lightTopOff: 'M150 P0', lightBottomOn: 'M150 P45 R255 U255 B255', lightBottomOff: 'M150 P0',
    pumpLeftOn: 'M106 P0 S255', pumpLeftOff: 'M107 P0', pumpRightOn: 'M106 P2 S255', pumpRightOff: 'M107 P2',
    valveLeftOn: 'M106 P1 S255', valveLeftOff: 'M107 P1', valveRightOn: 'M106 P3 S255', valveRightOff: 'M107 P3',
    nozzleLeftAxis: 'A', nozzleRightAxis: 'B', nozzleLeftCwPositive: true, nozzleRightCwPositive: true
  };
  // Presets and macros live in preferences, not in the command config: they never
  // change the wire format, so a machine profile stays portable between users.
  const PRESET_LIMIT = 60, MACRO_LIMIT = 60, STRENGTH_AXES = { pumpLeft:255, pumpRight:255, valveLeft:255, valveRight:255 };
  function validate(c) {
    if (!c || typeof c !== 'object' || ![1,2].includes(c.version)) throw Error('不支持的配置格式');
    const result = {};
    for (const [key, original] of Object.entries(DEFAULTS)) {
      const value = c[key] === undefined ? original : c[key];
      if (typeof value !== typeof original) throw Error('配置类型错误：' + key);
      result[key] = value;
    }
    if (c.version === 1 && !result.stopRaw && result.stop.trim().toUpperCase() === 'M112') result.stop = 'M410';
    result.version = 2;
    for (const [key, min, max] of [['baud', 300, 3000000], ['timeout', 1000, 180000], ['settle', 0, 15000]]) {
      if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw Error('配置数值超出范围：' + key);
    }
    if (!['LF', 'CRLF', 'CR'].includes(result.newline)) throw Error('行结束符无效');
    if (![result.nozzleLeftAxis,result.nozzleRightAxis].every(a=>/^[AB]$/.test(a)) || result.nozzleLeftAxis===result.nozzleRightAxis) throw Error('左右吸嘴必须分别映射到 A / B 轴');
    for (const k of ['ack', 'error']) { if (!result[k].trim()) throw Error('响应表达式不能为空'); new RegExp(result[k], 'i'); }
    if (!['{axis}', '{distance}', '{feed}'].every(t => result.jog.includes(t))) throw Error('点动模板必须包含 {axis}、{distance}、{feed}');
    for (const [k, v] of Object.entries(result)) if (typeof v === 'string' && (v.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))) throw Error('配置包含非法字符或过长：' + k);
    return result;
  }
  function lines(command) {
    if (typeof command !== 'string' || !command.trim()) throw Error('请先在指令配置中填写此功能的指令');
    if (/\{[^}]*\}/.test(command)) throw Error('指令中还有未替换的占位符');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(command)) throw Error('指令包含控制字符');
    const rows = command.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith(';'));
    if (!rows.length || rows.length > 64 || rows.some(s => s.length > 512)) throw Error('指令长度无效');
    return rows;
  }
  function jog(c, axis, distance, feed) {
    if (!['X', 'Y', 'Z'].includes(axis) || !Number.isFinite(distance) || Math.abs(distance) > 50 || distance === 0 || !Number.isFinite(feed) || feed <= 0 || feed > 10000) throw Error('点动参数无效');
    return c.jog.replaceAll('{axis}', axis).replaceAll('{distance}', String(Number(distance.toFixed(4)))).replaceAll('{feed}', String(feed));
  }
  function position(line) {
    const grbl = line.match(/(?:MPos|WPos):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/i);
    if (grbl) { const xyz = grbl.slice(1).map(Number); return xyz.every(Number.isFinite) ? { X: xyz[0], Y: xyz[1], Z: xyz[2], source: /MPos:/i.test(line) ? '机器坐标回报' : '工作坐标回报' } : null; }
    // Ignore Marlin step-count suffix; never invent coordinates after homing.
    const main = line.split(/Count/i)[0], data = {};
    for (const a of ['X','Y','Z','A','B']) { const m = main.match(new RegExp('(?:^|\\s)' + a + ':\\s*(-?\\d+(?:\\.\\d+)?)', 'i')); if (m) data[a] = Number(m[1]); }
    return Object.keys(data).length ? { ...data, source: '控制器坐标回报' } : null;
  }
  function raw(text) {
    return text.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h,16))).replace(/\\r/g,'\r').replace(/\\n/g,'\n');
  }
  function rotate(c, side, amount, feed, absolute=false) {
    if (!['Left','Right'].includes(side) || !Number.isFinite(amount) || Math.abs(amount)>360 || (!absolute && amount===0) || !Number.isFinite(feed) || feed<1 || feed>10000) throw Error('吸嘴角度或速度无效');
    const axis=c['nozzle'+side+'Axis'];
    if (!/^[AB]$/.test(axis)) throw Error('吸嘴轴映射无效');
    return `G21\n${absolute?'G90':'G91'}\nG1 ${axis}${Number(amount.toFixed(3))} F${feed}\nG90\nM400\n${c.position}`;
  }
  // Absolute travel to a saved coordinate. XY runs first at whatever Z we already hold,
  // then Z; M400 barriers keep the two moves from being blended into one diagonal.
  // Anything more exotic (raise Z first, probe, multi-point) belongs in a macro.
  function goTo(c, x, y, z, feed, feedZ) {
    if (![x, y, z].every(Number.isFinite)) throw Error('预设坐标无效');
    const f = Number(feed), fz = feedZ === undefined ? Number(feed) : Number(feedZ);
    if (![f, fz].every(v => Number.isFinite(v) && v >= 1 && v <= 10000)) throw Error('预设速度无效');
    return `G21\nG90\nG1 X${x.toFixed(3)} Y${y.toFixed(3)} F${f}\nM400\nG1 Z${z.toFixed(3)} F${fz}\nM400\n${c.position}`;
  }
  // Rewrite the S word of an on-command so a slider can drive pump/valve power.
  // Falls back to appending S for commands that carry no explicit power word.
  function withStrength(command, value) {
    const s = Math.round(Number(value));
    if (!Number.isFinite(s) || s < 0 || s > 255) throw Error('力度必须在 0–255 之间');
    const text = String(command).trim();
    if (!text) throw Error('指令为空');
    return /\bS\d+(?:\.\d+)?/i.test(text) ? text.replace(/\bS\d+(?:\.\d+)?/gi, 'S' + s) : text + ' S' + s;
  }
  // ---- Photon feeder bus (LumenPnP / Opulo) ----------------------------------
  // The controller relays these frames onto the RS485 feeder bus: a packet leaves
  // as `M485 <hex>` and the answer arrives as one `rs485-reply: <hex>` line.
  // Frame layout: [to, from, packetID, declaredLength, checksum, state, ...payload]
  // where declaredLength counts the command byte plus the payload bytes.
  const FEEDER = {
    GET_ID: { code: 1, type: 'UNICAST', length: 1 },
    INITIALIZE: { code: 2, type: 'UNICAST', length: 13 },
    GET_VERSION: { code: 3, type: 'UNICAST', length: 1 },
    MOVE_FEED_FORWARD: { code: 4, type: 'UNICAST', length: 2 },
    MOVE_FEED_BACKWARD: { code: 5, type: 'UNICAST', length: 2 },
    MOVE_FEED_STATUS: { code: 6, type: 'UNICAST', length: 1 },
    VENDOR_OPTIONS: { code: 191, type: 'UNICAST', length: 21 },
    GET_FEEDER_ADDRESS: { code: 192, type: 'BROADCAST', length: 13 },
    IDENTIFY_FEEDER: { code: 193, type: 'BROADCAST', length: 13 },
    PROGRAM_FEEDER_FLOOR: { code: 194, type: 'BROADCAST', length: 14 },
    UNINITIALIZED_FEEDERS_RESPOND: { code: 195, type: 'BROADCAST', length: 1 }
  };
  const FEEDER_BROADCAST = 255, FEEDER_SLOTS = 50, FEEDER_ID_BYTES = 12, FEEDER_FEED_STEP = 40;
  // Checksum used by the Opulo firmware: a 16-bit register shifted left, XORed with
  // 0x8380 whenever bit 15 is set, keeping the top byte. Transcribed from the
  // official debug tool so frames stay byte-compatible with real feeders.
  function feederChecksum(bytes) {
    let reg = 0;
    for (let n = 0; n < bytes.length; n++) {
      reg = reg ^ (bytes[n] << 8);
      for (let i = 0; i < 8; i++) { if (reg & 0x8000) reg = reg ^ 0x8380; reg <<= 1; }
    }
    return (reg >> 8) & 0xff;
  }
  function toHex(bytes) { return bytes.map(b => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(''); }
  function parseHex(text) {
    const clean = String(text === undefined || text === null ? '' : text).replace(/[\s,:]/g, '');
    if (!/^[0-9a-fA-F]*$/.test(clean)) throw Error('十六进制内容无效：只允许 0-9 与 A-F');
    if (clean.length % 2) throw Error('十六进制长度必须是偶数（每字节两位）');
    const out = [];
    for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
    return out;
  }
  // `command` is either a FEEDER key or a raw command byte. The raw form derives the
  // declared length from the payload — the official custom-packet tool reads the
  // wrong fields and sends a malformed frame, so this path is deliberately fixed.
  function feederFrame(options) {
    const { address, packetID } = options;
    let spec = null, code, declared;
    const payload = [...(options.payload || [])];
    if (typeof options.command === 'string') {
      spec = FEEDER[options.command];
      if (!spec) throw Error('未知的供料器指令：' + options.command);
      code = spec.code; declared = spec.length;
    } else if (Number.isInteger(options.command)) {
      code = options.command; declared = 1 + payload.length;
    } else throw Error('供料器指令无效');
    if (code < 0 || code > 255) throw Error('供料器指令码必须在 0–255 之间');
    if (!Number.isInteger(packetID) || packetID < 0 || packetID > 255) throw Error('包 ID 必须是 0–255');
    if (!payload.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw Error('载荷必须是 0–255 的字节');
    const broadcast = !!spec && spec.type === 'BROADCAST';
    const target = broadcast ? FEEDER_BROADCAST : Number(address);
    if (!broadcast && (!Number.isInteger(target) || target < 1 || target > 254)) throw Error('供料器地址必须是 1–254');
    if (declared > 1 && payload.length > declared - 1) throw Error('载荷超出该指令允许的长度');
    const bytes = [target, 0, packetID, declared, code];
    if (declared > 1) { bytes.push(...payload); while (bytes.length < 4 + declared) bytes.push(0); }
    const checksum = feederChecksum(bytes);
    bytes.splice(4, 0, checksum);
    return { bytes, checksum, gcode: 'M485 ' + toHex(bytes), broadcast, address: target, command: code, packetID };
  }
  // Parse an on-wire frame (checksum at index 4, command at index 5) exactly as the
  // bus sees it. Used by the demo bus and by the received-frame inspector.
  function feederRequest(bytes) {
    if (!Array.isArray(bytes) || bytes.length < 6) return null;
    const computed = feederChecksum([...bytes.slice(0, 4), ...bytes.slice(5)]);
    return { address: bytes[0], from: bytes[1], packetID: bytes[2], declared: bytes[3], checksum: bytes[4],
      checksumOk: computed === bytes[4], command: bytes[5], payload: bytes.slice(6) };
  }
  // Parse one serial line into a normalised answer; never throws.
  function feederReply(line) {
    const match = String(line).match(/rs485-reply:\s*(.*)$/i);
    if (!match) return null;
    const raw = match[1].trim();
    if (/^TIMEOUT$/i.test(raw)) return { status: 'timeout' };
    if (!raw) return { status: 'unsupported' };
    let bytes;
    try { bytes = parseHex(raw); } catch (e) { return { status: 'invalid', message: e.message }; }
    if (bytes.length < 6) return { status: 'invalid', message: '应答短于 6 字节' };
    const computed = feederChecksum([...bytes.slice(0, 4), ...bytes.slice(5)]);
    if (computed !== bytes[4]) return { status: 'checksum', checksum: bytes[4], computed };
    return { status: 'packet', to: bytes[0], from: bytes[1], packetID: bytes[2], length: bytes[3],
      checksum: bytes[4], state: bytes[5], id: toHex(bytes.slice(6)), payload: bytes.slice(6), bytes };
  }
  function feederPacketHex(from, packetID, stateByte, payload) {
    const head = [0, from, packetID, 1 + payload.length];
    const body = [stateByte, ...payload];
    return [...head, feederChecksum([...head, ...body]), ...body];
  }
  // Demo bus so the whole feeder panel can be exercised with no hardware attached.
  // Three programmed feeders plus one blank one that only answers the
  // "uninitialized feeders respond" broadcast, which is what the slot programmer hunts.
  function demoFeederNetwork() {
    const makeId = seed => Array.from({ length: FEEDER_ID_BYTES }, (_, i) => (seed * 37 + i * 11) & 0xff);
    const feeders = [
      { address: 1, id: makeId(3), initialized: true, version: '1.4.0' },
      { address: 2, id: makeId(7), initialized: true, version: '1.4.0' },
      { address: 50, id: makeId(11), initialized: true, version: '1.2.9' },
      { address: 0, id: makeId(23), initialized: false, version: '1.3.2' }
    ];
    const sameId = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    return {
      feeders,
      // Returns the reply byte array, or null to mean "nobody answered" (rs485 TIMEOUT).
      handle(request) {
        if (!request || !request.checksumOk) return null;   // a real feeder drops bad frames
        const live = feeders.filter(f => f.initialized);
        const byAddress = live.find(f => f.address === request.address);
        const byId = feeders.find(f => sameId(f.id, request.payload));
        const blank = feeders.find(f => !f.initialized);
        switch (request.command) {
          case FEEDER.GET_ID.code: return byAddress ? feederPacketHex(byAddress.address, request.packetID, 0, byAddress.id) : null;
          case FEEDER.INITIALIZE.code: return byAddress && sameId(byAddress.id, request.payload) ? feederPacketHex(byAddress.address, request.packetID, 0, []) : null;
          case FEEDER.GET_VERSION.code: return byAddress ? feederPacketHex(byAddress.address, request.packetID, 0, [1, 4, 0]) : null;
          case FEEDER.MOVE_FEED_FORWARD.code:
          case FEEDER.MOVE_FEED_BACKWARD.code: return byAddress ? feederPacketHex(byAddress.address, request.packetID, 0, []) : null;
          case FEEDER.MOVE_FEED_STATUS.code: return byAddress ? feederPacketHex(byAddress.address, request.packetID, 0, [0x01]) : null;
          case FEEDER.VENDOR_OPTIONS.code: {
            if (!byAddress) return null;
            const text = `FW ${byAddress.version} SLOT ${byAddress.address} BUILD 20260101`;
            const chunk = Array.from({ length: 16 }, (_, i) => (text.charCodeAt(request.payload[0] * 16 + i) || 32) & 0xff);
            return feederPacketHex(byAddress.address, request.packetID, 0, chunk);
          }
          case FEEDER.UNINITIALIZED_FEEDERS_RESPOND.code: return blank ? feederPacketHex(blank.address, request.packetID, 0, blank.id) : null;
          case FEEDER.PROGRAM_FEEDER_FLOOR.code: {
            if (!blank || !sameId(blank.id, request.payload.slice(0, FEEDER_ID_BYTES))) return null;
            blank.address = request.payload[FEEDER_ID_BYTES];
            blank.initialized = true;
            return feederPacketHex(blank.address, request.packetID, 0, []);
          }
          case FEEDER.GET_FEEDER_ADDRESS.code: return byId ? feederPacketHex(byId.initialized ? byId.address : 0, request.packetID, 0, []) : null;
          case FEEDER.IDENTIFY_FEEDER.code: return byId && byId.initialized ? feederPacketHex(byId.address, request.packetID, 0, []) : null;
          default: return null;
        }
      }
    };
  }
  // ---- Vacuum sensor over the I2C bridge (M260 / M261) ------------------------
  const VACUUM = { left: 1, right: 2, registers: [6, 7, 8], readCommand: 'M261 A109 B1 S1' };
  // The official tool's post-connect boot sequence. Never sent automatically here:
  // this bench writes nothing to the machine until you press a button.
  function vacuumBoot() {
    return ['G90', 'M260 A112 B1 S1', 'M260 A109', 'M260 B48', 'M260 B27', 'M260 S1',
      'M260 A112 B2 S1', 'M260 A109', 'M260 B48', 'M260 B27', 'M260 S1', 'G0 F35000'];
  }
  function vacuumSelect(side) {
    if (!(side in VACUUM)) throw Error('真空通道无效，只能是 left / right');
    return 'M260 A112 B' + VACUUM[side] + ' S1';
  }
  function vacuumAddress(register) {
    if (!VACUUM.registers.includes(register)) throw Error('真空寄存器无效，只能是 6 / 7 / 8');
    return 'M260 A109 B' + register + ' S1';
  }
  // Three bytes, most significant first, two's complement over 24 bits.
  function vacuumValue(msb, csb, lsb) {
    if (![msb, csb, lsb].every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw Error('真空传感器字节无效');
    const raw = (msb << 16) | (csb << 8) | lsb;
    return raw & (1 << 23) ? raw - (1 << 24) : raw;
  }
  function dataByte(line) {
    const m = String(line).match(/\bdata:\s*([0-9a-f]{2})\b/i);
    return m ? parseInt(m[1], 16) : null;
  }
  const PREFS = {version:1,mode:'demo',feed:1000,feedZ:300,xyStep:1,zStep:0.1,
    leftAngle:45,rightAngle:45,leftTarget:0,rightTarget:0,leftFeed:600,rightFeed:600,
    topRotation:0,bottomRotation:0,topMirror:false,bottomMirror:false,topCross:true,bottomCross:true,
    topDevice:'',bottomDevice:'',topDeviceLabel:'',bottomDeviceLabel:'',
    presets:[],macros:[],strength:{...STRENGTH_AXES}};
  function presets(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim()
        && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
      .slice(0, PRESET_LIMIT)
      .map(p => ({ name: p.name.trim().slice(0, 40), x: p.x, y: p.y, z: p.z }));
  }
  function macros(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(m => m && typeof m === 'object' && typeof m.name === 'string' && m.name.trim()
        && typeof m.command === 'string' && m.command.trim())
      .slice(0, MACRO_LIMIT)
      .map(m => ({ name: m.name.trim().slice(0, 40), command: m.command.slice(0, 2048) }));
  }
  function strength(value) {
    const out = { ...STRENGTH_AXES };
    if (value && typeof value === 'object') for (const key of Object.keys(out)) {
      const n = Number(value[key]);
      if (Number.isInteger(n) && n >= 0 && n <= 255) out[key] = n;
    }
    return out;
  }
  function preferences(input={}) {
    if (!input || typeof input!=='object') input={};
    const p={...PREFS,presets:[],macros:[],strength:{...STRENGTH_AXES}};
    for(const [key,value]of Object.entries(input)) if(key in p && typeof value===typeof p[key])p[key]=value;
    p.version=1;if(!['demo','serial'].includes(p.mode))p.mode='demo';
    for(const [key,min,max]of [['feed',1,10000],['feedZ',1,10000],['leftAngle',0.1,360],['rightAngle',0.1,360],['leftTarget',-360,360],['rightTarget',-360,360],['leftFeed',1,10000],['rightFeed',1,10000],['topRotation',-360,360],['bottomRotation',-360,360]])if(!Number.isFinite(p[key]) || p[key]<min || p[key]>max)p[key]=PREFS[key];
    for(const key of ['xyStep','zStep'])if(![0.1,1,5,10].includes(p[key]))p[key]=PREFS[key];
    for(const key of ['topDevice','bottomDevice','topDeviceLabel','bottomDeviceLabel'])if(p[key].length>512)p[key]='';
    p.presets=presets(p.presets);p.macros=macros(p.macros);p.strength=strength(p.strength);
    return p;
  }
  function imageBounds(width,height,degrees) {
    const r=degrees*Math.PI/180,c=Math.abs(Math.cos(r)),s=Math.abs(Math.sin(r));
    return {width:Math.ceil(width*c+height*s-1e-8),height:Math.ceil(width*s+height*c-1e-8)};
  }
  function endstop(line) {
    const m=line.match(/^\s*(?:echo:\s*)?([a-z][a-z0-9_]*)\s*:\s*(open|triggered)\s*$/i);
    return m?{name:m[1].toLowerCase(),triggered:m[2].toLowerCase()==='triggered'}:null;
  }
  async function discoverCameras(media, authorize=false) {
    let stream=null,authorizationError=null;
    try {
      if(authorize)try{stream=await media.getUserMedia({video:true,audio:false});}catch(e){authorizationError={name:e.name||'Error',message:e.message||String(e)};}
      // Enumerate while the temporary stream is live, including one-time permissions.
      const inputs=(await media.enumerateDevices()).filter(d=>d.kind==='videoinput');
      const devices=inputs.filter(d=>d.deviceId).map(d=>({deviceId:d.deviceId,label:d.label,groupId:d.groupId}));
      return {devices,hiddenCount:inputs.length-devices.length,authorizationError};
    } finally {stream?.getTracks().forEach(t=>t.stop());}
  }
  class Channel {
    constructor(write, config, log = () => {}) { this.write = write; this.config = config; this.log = log; this.pending = null; this.busy = false; this.halted = false; this.cancellations = 0; }
    receive(line) {
      this.log('rx', line);
      if (!this.pending) return;
      if (new RegExp(this.config.error, 'i').test(line)) this.pending.reject(Error('控制器报错：' + line));
      else if (this.pending.marker && (line.trim() === this.pending.marker || line.trim() === 'echo:' + this.pending.marker || line.trim() === 'echo: ' + this.pending.marker)) this.pending.seen = true;
      else if (new RegExp(this.config.ack, 'i').test(line) && (!this.pending.marker || this.pending.seen)) this.pending.resolve();
    }
    cancel(message = '操作已停止') { this.halted = true; ++this.cancellations; if (this.pending) this.pending.reject(Error(message)); }
    async synchronize(marker) {
      if (this.busy) throw Error('上一操作尚未结束');
      if (!/^BENCH_SYNC_[A-Z0-9_]+$/.test(marker)) throw Error('同步标记无效');
      this.busy = true;
      const generation = this.cancellations;
      let timer;
      const ack = new Promise((resolve,reject) => {
        timer = setTimeout(() => reject(Error('同步超时；控制器尚未恢复响应，运动保持锁定')), this.config.timeout);
        this.pending = {resolve,reject,marker,seen:false};
      });
      ack.catch(() => {});
      try {
        const row = 'M118 ' + marker;
        this.log('tx',row);
        await this.write(row + ({LF:'\n',CRLF:'\r\n',CR:'\r'}[this.config.newline]));
        await ack;
        if (generation !== this.cancellations) throw Error('恢复已取消');
        this.halted = false;
      } catch(e) { this.halted = true; throw e; }
      finally {clearTimeout(timer);this.pending=null;this.busy=false;}
    }
    async execute(command) {
      if (this.halted) throw Error('连接已锁定，请断开后重新连接');
      if (this.busy) throw Error('上一操作正在等待响应，请稍后再试');
      const rows = lines(command); this.busy = true;
      try {
        for (const row of rows) {
          if (this.halted) throw Error('操作已停止');
          let timer;
          const ack = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error('等待响应超时；连接已锁定，请检查设备后重新连接')), this.config.timeout);
            this.pending = { resolve, reject };
          });
          // Attach rejection handler before write; cancellation may arrive during it.
          ack.catch(() => {});
          try {
            this.log('tx', row);
            await this.write(row + ({ LF:'\n', CRLF:'\r\n', CR:'\r' }[this.config.newline]));
            await ack;
          } finally { clearTimeout(timer); this.pending = null; }
        }
      } catch (e) { this.halted = true; throw e; }
      finally { this.busy = false; }
    }
  }
  const api = { DEFAULTS, validate, lines, jog, position, raw, rotate, PREFS, preferences, imageBounds, endstop, discoverCameras, Channel, presets, macros, strength, goTo, withStrength,
    FEEDER, FEEDER_BROADCAST, FEEDER_SLOTS, FEEDER_ID_BYTES, FEEDER_FEED_STEP, feederChecksum, feederFrame, feederRequest, feederReply, feederPacketHex, demoFeederNetwork, toHex, parseHex,
    VACUUM, vacuumBoot, vacuumSelect, vacuumAddress, vacuumValue, dataByte };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Bench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
