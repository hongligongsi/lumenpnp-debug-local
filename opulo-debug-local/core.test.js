'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Bench = require('./core.js');
test('Marlin preset and config validation',()=>{
  assert.equal(Bench.validate({...Bench.DEFAULTS}).pumpRightOn,'M106 P2 S255');
  assert.throws(()=>Bench.validate({...Bench.DEFAULTS,ack:'['}));
  assert.throws(()=>Bench.validate({...Bench.DEFAULTS,timeout:0}));
  assert.throws(()=>Bench.validate({...Bench.DEFAULTS,sharedLights:'yes'}));
  assert.throws(()=>Bench.validate({...Bench.DEFAULTS,jog:'G1'}));
  assert.throws(()=>Bench.lines(''));
  assert.throws(()=>Bench.lines('G1 X{X}'));
});
test('jog emits one relative axis and restores absolute mode',()=>{
  assert.equal(Bench.jog(Bench.DEFAULTS,'Z',-0.1,600),'G21\nG91\nG1 Z-0.1 F600\nG90');
  assert.throws(()=>Bench.jog(Bench.DEFAULTS,'Z',Infinity,600));
  assert.throws(()=>Bench.jog(Bench.DEFAULTS,'X',1,0));
});
test('positions are parsed only from reports, ignoring step counts',()=>{
  assert.deepEqual(Bench.position('X:12.30 Y:-4.00 Z:1.25 Count X:982 Y:1 Z:2'),{X:12.3,Y:-4,Z:1.25,source:'控制器坐标回报'});
  assert.equal(Bench.position('ok'),null);
  assert.equal(Bench.position('<Idle|MPos:1.2,3.4,5.6|FS:0,0>').source,'机器坐标回报');
});
test('commands wait for acknowledgement before next line',async()=>{
  const sent=[];const channel=new Bench.Channel(async s=>sent.push(s),Bench.DEFAULTS);
  const action=channel.execute('G91\nG1 X1 F600\nG90');
  await new Promise(r=>setImmediate(r));assert.deepEqual(sent,['G91\n']);
  channel.receive('busy: processing');await new Promise(r=>setImmediate(r));assert.equal(sent.length,1);
  channel.receive('ok');await new Promise(r=>setImmediate(r));assert.equal(sent[1],'G1 X1 F600\n');
  channel.receive('ok');await new Promise(r=>setImmediate(r));assert.equal(sent[2],'G90\n');
  channel.receive('ok');await action;assert.equal(channel.busy,false);
});
test('controller errors halt all remaining lines',async()=>{
  const sent=[];const channel=new Bench.Channel(async s=>sent.push(s),Bench.DEFAULTS);
  const action=channel.execute('G91\nG1 X1 F600\nG90');const rejection=assert.rejects(action,/控制器报错/);
  channel.receive('Error: bad command');await rejection;assert.equal(sent.length,1);assert.equal(channel.halted,true);
  await assert.rejects(channel.execute('M114'),/连接已锁定/);
});
test('cancel while waiting prevents subsequent motion',async()=>{
  const sent=[];const channel=new Bench.Channel(async s=>sent.push(s),Bench.DEFAULTS);
  const action=channel.execute('G91\nG1 X1 F600');const rejection=assert.rejects(action,/操作已停止/);
  channel.cancel();await rejection;channel.receive('ok');assert.equal(sent.length,1);
});
test('timeout locks connection and concurrent commands are rejected',async()=>{
  const channel=new Bench.Channel(async()=>{},{...Bench.DEFAULTS,timeout:15});
  const action=channel.execute('M114');const rejection=assert.rejects(action,/等待响应超时/);
  await assert.rejects(channel.execute('G28'),/上一操作/);await rejection;assert.equal(channel.halted,true);
});
test('raw stop decodes explicit hex control bytes',()=>assert.equal(Bench.raw('\\x18'),String.fromCharCode(24)));
test('old default shutdown profiles migrate to quickstop while explicit v2 overrides remain',()=>{
  const old=Bench.validate({...Bench.DEFAULTS,version:1,stop:'M112'});
  assert.equal(old.version,2);assert.equal(old.stop,'M410');
  assert.equal(Bench.validate({...Bench.DEFAULTS,stop:'M112'}).stop,'M112');
});
test('stop bypasses pending acknowledgement and never emits remaining movement',async()=>{
  const sent=[];const c=new Bench.Channel(async s=>sent.push(s),Bench.DEFAULTS);
  const action=c.execute('G91\nG1 X10 F1000\nG90');const rejection=assert.rejects(action,/软件急停/);
  c.cancel('软件急停');await c.write('M410\n');await rejection;
  assert.deepEqual(sent,['G91\n','M410\n']);assert.equal(c.halted,true);
});
test('resume requires a fresh echo marker and following ack, ignoring stale ok',async()=>{
  const sent=[];const c=new Bench.Channel(async s=>sent.push(s),Bench.DEFAULTS);c.cancel();
  const sync=c.synchronize('BENCH_SYNC_TEST_1');
  c.receive('ok');c.receive('echo:enqueueing M118 BENCH_SYNC_TEST_1');c.receive('ok');
  await new Promise(r=>setImmediate(r));assert.equal(c.halted,true);assert.equal(c.busy,true);
  c.receive('echo:BENCH_SYNC_TEST_1');c.receive('ok');await sync;
  assert.equal(c.halted,false);assert.deepEqual(sent,['M118 BENCH_SYNC_TEST_1\n']);
  const query=c.execute('M114');c.receive('ok');await query;
});
test('another stop during recovery keeps the channel latched',async()=>{
  const c=new Bench.Channel(async()=>{},Bench.DEFAULTS);c.cancel();
  const sync=c.synchronize('BENCH_SYNC_TEST_2');const rejection=assert.rejects(sync,/再次急停/);
  c.cancel('再次急停');c.receive('BENCH_SYNC_TEST_2');c.receive('ok');await rejection;assert.equal(c.halted,true);
});
test('nozzle rotation generates isolated relative and absolute rotary movement',()=>{
  assert.equal(Bench.rotate(Bench.DEFAULTS,'Left',-45,600),'G21\nG91\nG1 A-45 F600\nG90\nM400\nM114');
  assert.equal(Bench.rotate(Bench.DEFAULTS,'Right',90,900,true),'G21\nG90\nG1 B90 F900\nG90\nM400\nM114');
  assert.throws(()=>Bench.rotate(Bench.DEFAULTS,'Left',361,600));
  assert.throws(()=>Bench.rotate(Bench.DEFAULTS,'Right',0,600));
  assert.throws(()=>Bench.validate({...Bench.DEFAULTS,nozzleLeftAxis:'B'}));
});
test('rotational positions are read alongside XYZ without reading step-count fields',()=>{
  const p=Bench.position('X:1 Y:2 Z:3 A:-45.25 B:90 Count A:222');
  assert.equal(p.A,-45.25);assert.equal(p.B,90);
});
test('all preference fields survive a JSON save and reload',()=>{
  const p=Bench.preferences({...Bench.PREFS,mode:'serial',feed:1200,feedZ:400,xyStep:5,zStep:1,leftAngle:30,rightAngle:60,leftTarget:90,rightTarget:-45,leftFeed:900,rightFeed:1200,topRotation:30,bottomRotation:-90,topMirror:true,bottomCross:false,topDevice:'device-a',bottomDevice:'device-b',topDeviceLabel:'TOP USB',bottomDeviceLabel:'BOTTOM USB'});
  assert.deepEqual(Bench.preferences(JSON.parse(JSON.stringify(p))),p);
});
test('corrupted persisted values fall back to valid defaults',()=>{
  const p=Bench.preferences({feed:0,xyStep:123,topRotation:Infinity,topMirror:'true',mode:'invalid',leftAngle:-5});
  assert.equal(p.feed,1000);assert.equal(p.xyStep,1);assert.equal(p.topRotation,0);assert.equal(p.topMirror,false);assert.equal(p.mode,'demo');assert.equal(p.leftAngle,45);
});
test('rotated frame bounds preserve the whole camera image',()=>{
  assert.deepEqual(Bench.imageBounds(1280,720,0),{width:1280,height:720});
  assert.deepEqual(Bench.imageBounds(1280,720,90),{width:720,height:1280});
  assert.deepEqual(Bench.imageBounds(1280,720,-90),{width:720,height:1280});
  assert.deepEqual(Bench.imageBounds(1280,720,180),{width:1280,height:720});
});
test('camera discovery sees all three devices before releasing temporary permission',async()=>{
  let live=false;const media={getUserMedia:async()=>{live=true;return{getTracks:()=>[{stop:()=>{live=false;}}]};},enumerateDevices:async()=>live?['2M','FHD C3 Camera','Integrated Camera'].map((label,i)=>({kind:'videoinput',deviceId:String(i+1),label})):[{kind:'videoinput',deviceId:'2',label:'FHD C3 Camera'}]};
  const result=await Bench.discoverCameras(media,true);assert.equal(result.devices.length,3);assert.equal(live,false);assert.equal(result.authorizationError,null);
});
test('camera capture failure still enumerates other available devices',async()=>{
  const result=await Bench.discoverCameras({getUserMedia:async()=>{throw Object.assign(Error('busy'),{name:'NotReadableError'});},enumerateDevices:async()=>[{kind:'videoinput',deviceId:'other',label:'2M'},{kind:'videoinput',deviceId:'',label:''},{kind:'audioinput',deviceId:'mic'}]},true);
  assert.equal(result.devices.length,1);assert.equal(result.hiddenCount,1);assert.equal(result.authorizationError.name,'NotReadableError');
});
test('failed camera enumeration releases temporary camera and passive scan never requests access',async()=>{
  let stopped=false;await assert.rejects(Bench.discoverCameras({getUserMedia:async()=>({getTracks:()=>[{stop:()=>{stopped=true;}}]}),enumerateDevices:async()=>{throw Error('enumeration failed');}},true));assert.equal(stopped,true);
  const result=await Bench.discoverCameras({getUserMedia:async()=>{throw Error('must not request');},enumerateDevices:async()=>[]});assert.equal(result.devices.length,0);assert.equal(result.authorizationError,null);
});
test('Marlin limit reports parse triggered, open and additional inputs without inventing states',()=>{
  assert.deepEqual(Bench.endstop('x_min: open'),{name:'x_min',triggered:false});
  assert.deepEqual(Bench.endstop('echo: Y_MAX: TRIGGERED'),{name:'y_max',triggered:true});
  assert.deepEqual(Bench.endstop('z2_min: TRIGGERED'),{name:'z2_min',triggered:true});
  assert.deepEqual(Bench.endstop('z_probe: open'),{name:'z_probe',triggered:false});
  for(const line of ['ok','Reporting endstop status','x_min: unknown','X:0 Y:0 Z:0','x_min: open extra'])assert.equal(Bench.endstop(line),null);
});
test('saved positions drop incomplete entries and stop at the list cap',()=>{
  assert.deepEqual(Bench.presets([{name:' PCB 原点 ',x:1,y:2,z:3},{name:'',x:1,y:2,z:3},{name:'缺 Z',x:1,y:2},{name:'字符串坐标',x:'1',y:2,z:3},null,{name:'换料位',x:-4.5,y:0,z:12.25}]),
    [{name:'PCB 原点',x:1,y:2,z:3},{name:'换料位',x:-4.5,y:0,z:12.25}]);
  assert.deepEqual(Bench.presets('nope'),[]);
  assert.equal(Bench.presets(Array.from({length:80},(_,i)=>({name:'p'+i,x:i,y:0,z:0}))).length,60);
});
test('preset travel commits XY before Z inside an absolute frame',()=>{
  assert.equal(Bench.goTo(Bench.DEFAULTS,1.5,-2,3.25,1000,300),'G21\nG90\nG1 X1.500 Y-2.000 F1000\nM400\nG1 Z3.250 F300\nM400\nM114');
  assert.equal(Bench.goTo(Bench.DEFAULTS,0,0,0,600),'G21\nG90\nG1 X0.000 Y0.000 F600\nM400\nG1 Z0.000 F600\nM400\nM114');
  assert.throws(()=>Bench.goTo(Bench.DEFAULTS,NaN,0,0,600));
  assert.throws(()=>Bench.goTo(Bench.DEFAULTS,0,0,0,0));
  assert.throws(()=>Bench.goTo(Bench.DEFAULTS,0,0,0,600,20000));
});
test('macros need both a name and a command to be kept',()=>{
  assert.deepEqual(Bench.macros([{name:' 回零 ',command:' G28 '},{name:'空',command:'   '},{command:'M115'},null]),
    [{name:'回零',command:' G28 '}]);
  assert.deepEqual(Bench.macros({}),[]);
  assert.equal(Bench.macros(Array.from({length:70},(_,i)=>({name:'m'+i,command:'M114'}))).length,60);
});
test('pump and valve strength only accepts integers inside 0–255',()=>{
  assert.deepEqual(Bench.strength({pumpLeft:0,valveRight:255}),{pumpLeft:0,pumpRight:255,valveLeft:255,valveRight:255});
  assert.deepEqual(Bench.strength({pumpLeft:256,valveLeft:-1,pumpRight:12.5}),{pumpLeft:255,pumpRight:255,valveLeft:255,valveRight:255});
  assert.deepEqual(Bench.strength(),{pumpLeft:255,pumpRight:255,valveLeft:255,valveRight:255});
});
test('the power slider rewrites the S word instead of stacking a second one',()=>{
  assert.equal(Bench.withStrength('M106 P0 S255',80),'M106 P0 S80');
  assert.equal(Bench.withStrength('m106 p2 s0',200),'m106 p2 S200');
  assert.equal(Bench.withStrength('M106 P1',123),'M106 P1 S123');
  assert.throws(()=>Bench.withStrength('M106 P0 S255',300));
  assert.throws(()=>Bench.withStrength('',100));
});
test('presets, macros and strength ride along in the saved preference bundle',()=>{
  const p=Bench.preferences({presets:[{name:'原点',x:0,y:0,z:0}],macros:[{name:'固件',command:'M115'}],strength:{pumpLeft:64}});
  assert.deepEqual(Bench.preferences(JSON.parse(JSON.stringify(p))),p);
  assert.deepEqual(Bench.preferences({presets:'bad',macros:7,strength:[]}).presets,[]);
  assert.equal(Bench.PREFS.presets.length,0);
});
// ---- Photon feeder bus -------------------------------------------------------
// Vectors below were produced by running the checksum extracted from the official
// Opulo debug bundle; they pin this port to the same polynomial so frames stay
// byte-compatible with real feeders.
test('feeder checksum matches the firmware polynomial',()=>{
  assert.equal(Bench.feederChecksum([]),0);
  assert.equal(Bench.feederChecksum([0]),0);
  assert.equal(Bench.feederChecksum([255]),243);
  assert.equal(Bench.feederChecksum([0,0,0,1,1]),18);
  assert.equal(Bench.feederChecksum([1,0,0,1,1]),112);
  assert.equal(Bench.feederChecksum([1,0,0,13,2]),133);
  assert.equal(Bench.feederChecksum([0,2,0,1,1]),62);
});
test('feeder frames carry target, length, checksum and M485 wrapper',()=>{
  assert.equal(Bench.feederFrame({command:'GET_ID',address:1,packetID:0}).gcode,'M485 010000017001');
  assert.equal(Bench.feederFrame({command:'GET_ID',address:1,packetID:255}).gcode,'M485 0100FF015B01');
  assert.equal(Bench.feederFrame({command:'IDENTIFY_FEEDER',address:99,packetID:7,payload:Array(12).fill(0xAB)}).gcode,
    'M485 FF00070D20C1ABABABABABABABABABABABAB');
  // broadcast commands always address 255 whatever the caller asked for
  assert.equal(Bench.feederFrame({command:'IDENTIFY_FEEDER',address:99,packetID:7,payload:Array(12).fill(0xAB)}).address,255);
  // short fixed-width payloads are zero padded to the declared length
  const init=Bench.feederFrame({command:'INITIALIZE',address:3,packetID:2,payload:[1,2,3]});
  assert.equal(init.bytes.length,4+13+1);
  assert.equal(init.bytes[3],13);
  assert.deepEqual(init.bytes.slice(5),[2,1,2,3,0,0,0,0,0,0,0,0,0]);
});
test('a raw command byte derives its length from the payload',()=>{
  assert.equal(Bench.feederFrame({command:128,address:5,packetID:3,payload:[1,2]}).gcode,'M485 0500030326800102');
  assert.equal(Bench.feederFrame({command:128,address:5,packetID:3}).bytes[3],1);
});
test('feeder frames reject impossible addressing and payloads',()=>{
  assert.throws(()=>Bench.feederFrame({command:'NOPE',address:1,packetID:0}));
  assert.throws(()=>Bench.feederFrame({command:'GET_ID',address:0,packetID:0}));
  assert.throws(()=>Bench.feederFrame({command:'GET_ID',address:255,packetID:0}));
  assert.throws(()=>Bench.feederFrame({command:'GET_ID',address:1.5,packetID:0}));
  assert.throws(()=>Bench.feederFrame({command:'GET_ID',address:1,packetID:256}));
  assert.throws(()=>Bench.feederFrame({command:'MOVE_FEED_FORWARD',address:1,packetID:0,payload:[1,2,3]}));
  assert.throws(()=>Bench.feederFrame({command:'MOVE_FEED_FORWARD',address:1,packetID:0,payload:[300]}));
  assert.throws(()=>Bench.feederFrame({command:999,address:1,packetID:0}));
});
test('replies are classified into timeout, unsupported, checksum and packet',()=>{
  assert.deepEqual(Bench.feederReply('rs485-reply: TIMEOUT'),{status:'timeout'});
  assert.deepEqual(Bench.feederReply('rs485-reply: '),{status:'unsupported'});
  assert.equal(Bench.feederReply('ok'),null);
  assert.equal(Bench.feederReply('rs485-reply: zz').status,'invalid');
  assert.equal(Bench.feederReply('rs485-reply: 0100').status,'invalid');
  const bad=Bench.feederReply('rs485-reply: 01000001700101');
  assert.equal(bad.status,'checksum');assert.equal(bad.checksum,0x70);assert.equal(bad.computed,0x50);
  const ok=Bench.feederReply('rs485-reply: 01030000E2000A2C');
  assert.equal(ok.status,'packet');assert.equal(ok.from,3);assert.equal(ok.packetID,0);assert.equal(ok.state,0);assert.equal(ok.id,'0A2C');
  assert.deepEqual(ok.payload,[10,44]);
});
test('feeder request parser verifies the checksum it received',()=>{
  const good=Bench.feederRequest(Bench.parseHex(Bench.feederFrame({command:'GET_ID',address:1,packetID:0}).gcode.slice(5)));
  assert.equal(good.command,1);assert.equal(good.address,1);assert.equal(good.checksumOk,true);
  const tampered=Bench.feederRequest(Bench.parseHex('010000017101'));
  assert.equal(tampered.checksumOk,false);
  assert.equal(Bench.feederRequest([1,2,3]),null);
});
test('hex helpers round-trip and refuse malformed input',()=>{
  assert.equal(Bench.toHex([0,15,255]),'000FFF');
  assert.deepEqual(Bench.parseHex('00 0f,FF'),[0,15,255]);
  assert.deepEqual(Bench.parseHex(''),[]);
  assert.throws(()=>Bench.parseHex('0G'));
  assert.throws(()=>Bench.parseHex('ABC'));
});
test('the demo bus answers a full scan and only accepts the matching feeder ID',()=>{
  const bus=Bench.demoFeederNetwork();
  const send=(command,address,packetID,payload)=>{
    const frame=Bench.feederFrame({command,address,packetID,payload});
    return bus.handle(Bench.feederRequest(Bench.parseHex(frame.gcode.slice(5))));
  };
  assert.equal(send('GET_ID',7,0),null,'no feeder at slot 7');
  const found=send('GET_ID',1,1);
  assert.equal(found.length,4+1+Bench.FEEDER_ID_BYTES+1);
  const id=found.slice(6);
  assert.equal(send('INITIALIZE',1,2,Array(12).fill(0)),null,'wrong UUID is ignored');
  assert.ok(send('INITIALIZE',1,3,id),'matching UUID is accepted');
  assert.ok(send('MOVE_FEED_FORWARD',1,4,[Bench.FEEDER_FEED_STEP]));
  assert.ok(send('GET_VERSION',50,5));
  assert.equal(send('GET_VERSION',9,6),null);
});
test('the slot programmer hands a blank feeder its new address',()=>{
  const bus=Bench.demoFeederNetwork();
  const send=(command,address,packetID,payload)=>{
    const frame=Bench.feederFrame({command,address,packetID,payload});
    return bus.handle(Bench.feederRequest(Bench.parseHex(frame.gcode.slice(5))));
  };
  const blank=send('UNINITIALIZED_FEEDERS_RESPOND',255,0);
  assert.ok(blank,'a blank feeder answers the broadcast');
  const id=blank.slice(6);
  assert.equal(send('PROGRAM_FEEDER_FLOOR',255,1,id.concat([17])).slice(1,2)[0],17);
  assert.equal(send('IDENTIFY_FEEDER',255,2,id).slice(1,2)[0],17,'now reachable at 17');
  assert.equal(send('UNINITIALIZED_FEEDERS_RESPOND',255,3),null,'and no longer blank');
  assert.equal(bus.feeders.filter(f=>!f.initialized).length,0);
});
test('demo frames survive the encode/decode round trip the panel relies on',()=>{
  const bus=Bench.demoFeederNetwork();
  const frame=Bench.feederFrame({command:'GET_ID',address:1,packetID:9});
  const reply=Bench.feederReply('rs485-reply: '+Bench.toHex(bus.handle(Bench.feederRequest(Bench.parseHex(frame.gcode.slice(5))))));
  assert.equal(reply.status,'packet');
  assert.equal(reply.packetID,9);
  assert.equal(reply.from,1);
  assert.equal(reply.id.length,24);
});
// ---- Vacuum sensor -----------------------------------------------------------
test('vacuum channel and register helpers only accept known values',()=>{
  assert.equal(Bench.vacuumSelect('left'),'M260 A112 B1 S1');
  assert.equal(Bench.vacuumSelect('right'),'M260 A112 B2 S1');
  assert.equal(Bench.vacuumAddress(6),'M260 A109 B6 S1');
  assert.equal(Bench.vacuumAddress(8),'M260 A109 B8 S1');
  assert.throws(()=>Bench.vacuumSelect('centre'));
  assert.throws(()=>Bench.vacuumAddress(5));
  assert.equal(Bench.VACUUM.readCommand,'M261 A109 B1 S1');
});
test('24-bit vacuum readings decode as signed values',()=>{
  assert.equal(Bench.vacuumValue(0x00,0x00,0x00),0);
  assert.equal(Bench.vacuumValue(0x00,0x01,0x00),256);
  assert.equal(Bench.vacuumValue(0x7F,0xFF,0xFF),8388607);
  assert.equal(Bench.vacuumValue(0x80,0x00,0x00),-8388608);
  assert.equal(Bench.vacuumValue(0xFF,0xFF,0xFF),-1);
  assert.throws(()=>Bench.vacuumValue(0,0,256));
});
test('vacuum data lines are read as hex bytes and nothing else',()=>{
  assert.equal(Bench.dataByte('data:E6'),0xE6);
  assert.equal(Bench.dataByte('echo:data:0a'),10);
  assert.equal(Bench.dataByte('data: 7F'),0x7F);
  assert.equal(Bench.dataByte('data:ZZ'),null);
  assert.equal(Bench.dataByte('ok'),null);
  assert.equal(Bench.dataByte('X:1 Y:2'),null);
});
test('the official boot sequence is replayed verbatim on request',()=>{
  const boot=Bench.vacuumBoot();
  assert.equal(boot.length,12);
  assert.equal(boot[0],'G90');
  assert.equal(boot[1],Bench.vacuumSelect('left'));
  assert.equal(boot[6],Bench.vacuumSelect('right'));
  assert.equal(boot[boot.length-1],'G0 F35000');
  for(const line of boot)assert.doesNotThrow(()=>Bench.lines(line));
});
