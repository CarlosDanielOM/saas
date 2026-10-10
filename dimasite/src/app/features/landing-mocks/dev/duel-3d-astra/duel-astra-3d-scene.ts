import * as T from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DuelBattle, DuelSide, DuelTurn, COMBO_HEAL, otherSide, turnLength } from '../../../widgets/duel/duel-battle';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { fighterRig, FighterRig, animateCloth } from './duel-astra-3d-rig';
import { DuelEffects } from './duel-astra-3d-effects';

export interface DuelSceneState { battle:DuelBattle; elapsed:number; started:boolean; paused:boolean; transparent:boolean }
export interface DuelSceneStats { fps:number; calls:number; triangles:number }
const clamp=T.MathUtils.clamp, smooth=(n:number)=>{const p=clamp(n,0,1);return p*p*(3-2*p);};
const FPS=60, FRAME_MS=1000/FPS;

/** This renderer is reachable only from the development mock's Astra slot. */
export class DuelAstra3dScene {
  private readonly renderer:T.WebGLRenderer;
  private readonly scene=new T.Scene();
  private readonly fog=new T.FogExp2('#080c18',.026);
  private readonly camera=new T.PerspectiveCamera(39,16/9,.1,60);
  private readonly composer:EffectComposer;
  private readonly bloom:UnrealBloomPass;
  private readonly environment=new T.Group();
  private readonly effects=new DuelEffects();
  private readonly moon=new T.Group();
  private readonly atmosphere:T.Points;
  private readonly floorMaterial:T.ShaderMaterial;
  private readonly backLight=new T.PointLight('#9470ff',5,18);
  private readonly keyLight=new T.DirectionalLight('#dbe8ff',4);
  private readonly accentLight=new T.PointLight('#ffcb9e',3.2,15);
  private readonly sparks:T.Mesh[]=[];
  private readonly rigs:Partial<Record<DuelSide,FighterRig>>={};
  private readonly observer:ResizeObserver;
  private readonly motion=matchMedia('(prefers-reduced-motion: reduce)');
  private timer:ReturnType<typeof setTimeout>|undefined;
  private previousBattle:DuelBattle|null=null;
  private dirty=true;
  private dead=false;
  private frameCount=0;
  private statsAt=performance.now();
  private statsFrames=0;
  private lastTime=-1;
  private lastFlags='';
  private worldTime=0;
  private lastTick=performance.now();
  private readonly aim=new T.Vector3();
  private readonly cameraTarget=new T.Vector3();
  private readonly intervals:number[]=[];
  private readonly envMap:T.WebGLRenderTarget;
  private lastDraw=0;

  constructor(private readonly canvas:HTMLCanvasElement,private readonly state:()=>DuelSceneState,private readonly stats:(stats:DuelSceneStats)=>void,private readonly failure:()=>void) {
    this.renderer=new T.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(1);
    const room=new RoomEnvironment(),pmrem=new T.PMREMGenerator(this.renderer);
    this.envMap=pmrem.fromScene(room,.04);this.scene.environment=this.envMap.texture;this.scene.environmentIntensity=.65;
    room.dispose();pmrem.dispose();
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFSoftShadowMap;
    this.renderer.toneMapping=T.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.05;
    this.renderer.info.autoReset=false;
    this.scene.fog=this.fog;
    this.scene.add(this.environment,this.effects.root,new T.HemisphereLight('#8d9ec6','#232039',2.1));
    this.keyLight.position.set(-3,7,5);this.keyLight.castShadow=true;
    this.keyLight.shadow.mapSize.set(2048,2048);this.keyLight.shadow.camera.left=-7;this.keyLight.shadow.camera.right=7;
    this.keyLight.shadow.camera.top=7;this.keyLight.shadow.camera.bottom=-7;this.keyLight.shadow.normalBias=.035;
    this.keyLight.shadow.bias=-.0003;this.scene.add(this.keyLight);
    this.backLight.position.set(-3,3,-3);this.accentLight.position.set(3,2.3,2);this.scene.add(this.backLight,this.accentLight);
    const stone=new T.MeshStandardMaterial({color:'#151c2e',metalness:.72,roughness:.32});
    const edge=new T.MeshStandardMaterial({color:'#333951',metalness:.75,roughness:.28});
    const luminous=new T.MeshBasicMaterial({color:'#b8a077',toneMapped:false});
    const platform=new T.Mesh(new T.CylinderGeometry(4.65,4.8,.42,64),stone);platform.position.y=-.26;platform.receiveShadow=true;this.environment.add(platform);
    this.buildInlays(edge,luminous);
    this.floorMaterial=new T.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{uTime:{value:0},uRage:{value:0},uPower:{value:0}},
      vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:`varying vec2 vUv;uniform float uTime;uniform float uRage;uniform float uPower;
      void main(){vec2 p=(vUv-.5)*2.;float r=length(p);float a=atan(p.y,p.x);
      float ring=exp(-abs(r-.87)*280.)+exp(-abs(r-.8)*220.)*.25+exp(-abs(r-.56)*180.)*.15;
      float rune=step(.94,cos(a*36.))*smoothstep(.78,.8,r)*(1.-smoothstep(.82,.85,r));
      float grid=pow(max(0.,cos(p.x*30.)),50.)+pow(max(0.,cos(p.y*30.)),50.);
      vec3 color=mix(vec3(.35,.29,.67),vec3(1.,.12,.2),uRage);float wave=exp(-abs(r-fract(uTime*.13))*100.)*.12;
      float alpha=(ring*.55+rune*.5+grid*.055+wave)*smoothstep(1.,.92,r);gl_FragColor=vec4(color*(1.+uPower*2.),alpha);}`});
    const floor=new T.Mesh(new T.PlaneGeometry(9.25,9.25),this.floorMaterial);floor.rotation.x=-Math.PI/2;floor.position.y=-.025;this.environment.add(floor);
    for(let i=0;i<3;i++) {
      const rim=new T.Mesh(new T.TorusGeometry(4.67,.018,5,96),i===1?luminous:edge);rim.rotation.x=-Math.PI/2;rim.position.y=-.1-i*.1;this.environment.add(rim);
    }
    // Broken, floating gateway: the silhouette anchors the camera without a flat backdrop.
    this.environment.add(this.moon);this.moon.position.set(0,3.5,-4.3);
    for(let i=0;i<12;i++) {
      const arc=new T.Mesh(new T.TorusGeometry(2.35,.15,5,12,.39),edge);arc.rotation.z=i*Math.PI/6;this.moon.add(arc);
      const lit=new T.Mesh(new T.TorusGeometry(2.355,.012,4,12,.34),luminous);lit.rotation.z=i*Math.PI/6+.025;lit.position.z=.16;this.moon.add(lit);
    }
    const eclipse=new T.Mesh(new T.SphereGeometry(1.92,64,40),new T.MeshBasicMaterial({color:'#0a0e20'}));eclipse.scale.z=.3;this.moon.add(eclipse);
    const eclipseRim=new T.Mesh(new T.TorusGeometry(1.97,.028,8,128),new T.MeshBasicMaterial({color:'#e2c59b',toneMapped:false}));this.moon.add(eclipseRim);
    for(let i=0;i<18;i++) {
      const a=i*2.399,r=5+(i%4)*.7;
      const shard=new T.Mesh(new T.OctahedronGeometry(.18+(i%3)*.09),stone);
      shard.position.set(Math.cos(a)*r,.15+(i%5)*.2,Math.sin(a)*r);shard.rotation.set(a,a*.3,a*.2);this.environment.add(shard);this.sparks.push(shard);
    }
    // Architectural pillars, cut into facets rather than a full-screen expensive sky.
    for(const side of [-1,1])for(let i=0;i<3;i++) {
      const pillar=new T.Mesh(new T.CylinderGeometry(.18,.32,3.4+i*.65,5),stone);
      pillar.position.set(side*(5+i*.9),1.3,-3.7-i*.8);pillar.rotation.z=side*-.13;this.environment.add(pillar);
      const vein=new T.Mesh(new T.BoxGeometry(.028,2.2,.03),luminous);vein.position.set(side*(5+i*.9),1.3,-3.48-i*.8);this.environment.add(vein);
    }
    const stars=new Float32Array(200*3);
    for(let i=0;i<200;i++){stars[i*3]=Math.sin(i*128.23)*11;stars[i*3+1]=Math.abs(Math.sin(i*93.13))*8;stars[i*3+2]=-3-Math.abs(Math.cos(i*64.37))*10;}
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.BufferAttribute(stars,3));
    this.atmosphere=new T.Points(geo,new T.PointsMaterial({color:'#b8b6ed',size:.022,transparent:true,opacity:.65,blending:T.AdditiveBlending,depthWrite:false}));this.environment.add(this.atmosphere);
    const target=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,samples:4});
    this.composer=new EffectComposer(this.renderer,target);this.composer.addPass(new RenderPass(this.scene,this.camera));
    this.bloom=new UnrealBloomPass(new T.Vector2(800,450),.45,.4,1.8);this.composer.addPass(this.bloom);this.composer.addPass(new OutputPass());
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement!);
    this.motion.addEventListener('change',this.motionChanged);
    canvas.addEventListener('webglcontextlost',this.contextLost);
    canvas.dataset['fpsCap']=String(FPS);canvas.dataset['renderer']='astra';
    this.resize();this.tick();
  }

  private buildInlays(stone:T.Material,light:T.Material):void {
    const ticks=new T.InstancedMesh(new T.BoxGeometry(.022,.012,.14),light,96),m=new T.Object3D();
    for(let i=0;i<96;i++) {
      const a=i*Math.PI/48;m.position.set(Math.cos(a)*4.22,-.032,Math.sin(a)*4.22);m.rotation.y=-a+Math.PI/2;
      m.scale.set(1,1,i%4===0?2:1);m.updateMatrix();ticks.setMatrixAt(i,m.matrix);
    }
    this.environment.add(ticks);
    for(const radius of [2.85,3.85,4.42]) {
      const ring=new T.Mesh(new T.TorusGeometry(radius,.009,6,128),light);ring.rotation.x=-Math.PI/2;ring.position.y=-.035;this.environment.add(ring);
    }
    const step=new T.Mesh(new T.CylinderGeometry(4.89,5.02,.16,96),stone);step.position.y=-.55;this.environment.add(step);
    for(let i=0;i<8;i++) {
      const a=i*Math.PI/4,seal=new T.Mesh(new T.TorusGeometry(.14,.011,6,4),light);
      seal.rotation.set(-Math.PI/2,0,a);seal.position.set(Math.cos(a)*3.86,-.023,Math.sin(a)*3.86);this.environment.add(seal);
    }
  }

  private readonly motionChanged=()=>{this.dirty=true;};
  private readonly contextLost=(event:Event)=>{event.preventDefault();this.failure();this.dispose();};
  private resize():void {
    if(this.dead)return;
    const rect=this.canvas.parentElement!.getBoundingClientRect();
    // Supersample desktop, honor Retina phones, and bound the total render workload.
    const density=Math.min(2,Math.max(1.35,window.devicePixelRatio||1),1920/Math.max(1,rect.width));
    const w=Math.max(1,Math.round(rect.width*density)),h=Math.max(1,Math.round(rect.height*density));
    this.canvas.dataset['resolution']=`${w}×${h}`;
    this.renderer.setSize(w,h,false);this.composer.setSize(w,h);
    this.bloom.setSize(Math.ceil(w/2),Math.ceil(h/2));
    this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.dirty=true;
  }

  private readonly tick=():void=>{
    if(this.dead)return;
    const frameStart=performance.now(),snapshot=this.state();
    const flags=`${snapshot.started}|${snapshot.paused}|${snapshot.transparent}`;
    const changed=this.lastTime!==snapshot.elapsed||this.previousBattle!==snapshot.battle||flags!==this.lastFlags;
    if(!document.hidden&&(this.dirty||changed||!snapshot.paused&&!this.motion.matches)) {
      const delta=Math.min(.1,(frameStart-this.lastTick)/1000);
      if(!snapshot.paused&&!this.motion.matches)this.worldTime+=delta;
      this.update(snapshot,this.motion.matches?0:this.worldTime);
      this.renderer.info.reset();
      if(snapshot.transparent)this.renderer.render(this.scene,this.camera);else this.composer.render();
      this.frameCount++;this.statsFrames++;
      this.canvas.dataset['frames']=String(this.frameCount);
      this.canvas.dataset['drawCalls']=String(this.renderer.info.render.calls);
      if(this.lastDraw)this.intervals.push(frameStart-this.lastDraw);
      if(this.intervals.length>120)this.intervals.shift();this.lastDraw=frameStart;
      if(frameStart-this.statsAt>=1000) {
        this.stats({fps:Math.round(this.statsFrames*1000/(frameStart-this.statsAt)),calls:this.renderer.info.render.calls,triangles:this.renderer.info.render.triangles});
        this.canvas.dataset['frameIntervals']=JSON.stringify(this.intervals);
        this.statsAt=frameStart;this.statsFrames=0;
      }
      this.lastTime=snapshot.elapsed;this.lastFlags=flags;this.dirty=false;
    }
    this.lastTick=frameStart;
    // Bound drawing to 60 FPS without catch-up bursts; paused scenes only redraw when dirty.
    this.timer=setTimeout(this.tick,Math.max(1,Math.ceil(FRAME_MS-(performance.now()-frameStart))));
  };

  private update(state:DuelSceneState,t:number):void {
    if(this.previousBattle!==state.battle) {
      for(const side of ['left','right'] as const) {
        const old=this.rigs[side];if(old){this.scene.remove(old.root);disposeObject(old.root);}
        const rig=fighterRig(state.battle.fighters[side],side,state.battle.enraged===side);
        this.rigs[side]=rig;this.scene.add(rig.root);
      }
      this.previousBattle=state.battle;
    }
    this.environment.visible=!state.transparent;this.scene.fog=state.transparent?null:this.fog;
    this.renderer.setClearColor('#080c18',state.transparent?0:1);
    this.floorMaterial.uniforms['uTime'].value=t;
    this.floorMaterial.uniforms['uRage'].value=state.battle.enraged?.length?1:0;
    this.moon.rotation.z=Math.sin(t*.13)*.06;this.atmosphere.rotation.y=t*.008;
    for(let i=0;i<this.sparks.length;i++){this.sparks[i].rotation.y=t*.15+i;this.sparks[i].position.y=.18+(i%5)*.2+Math.sin(t+i)*.09;}
    const time=state.started?state.elapsed:0;
    // Use the battle clock for reproducible poses, including rewind and pause.
    if(state.started)t=time/1000;
    const last=state.battle.turns.at(-1),turn=[...state.battle.turns].reverse().find(turn=>turn.at<=time&&time<turn.at+(turn.move==='ultimate'?5000:turnLength(turn)))??null;
    const ultimate=turn?.move==='ultimate'?turn:null,age=ultimate?(time-ultimate.at)/1000:0;
    const done=state.started&&time>=state.battle.duration;
    const health=healthAt(state.battle,time,state.started);
    this.effects.hide();
    let cameraX=Math.sin(t*.16)*.35,cameraY=3.6,cameraZ=this.camera.aspect<1.35?12.8:10.5,aimY=1.38;
    if(ultimate&&!done) {
      const direction=ultimate.attacker==='left'?-1:1,zoom=Math.sin(clamp(age/2.8,0,1)*Math.PI);
      cameraX=direction*zoom*.95;cameraY-=zoom*.95;cameraZ-=zoom*1.2;aimY+=zoom*.35;
      const hit=Math.max(0,age-(ultimate.hitAt-ultimate.at)/1000),shake=Math.max(0,1-hit/.65)*.11;
      if(hit>0&&!this.motion.matches){cameraX+=Math.sin(hit*61)*shake;cameraY+=Math.cos(hit*77)*shake;}
    }
    if(done){cameraX=state.battle.winner==='left'?-1.5:1.5;cameraZ-=1.5;aimY=1.35;}
    if(this.motion.matches){cameraX=0;cameraY=3.55;cameraZ=this.camera.aspect<1.35?13.4:10.8;}
    this.cameraTarget.set(cameraX,cameraY,cameraZ);this.camera.position.copy(this.cameraTarget);
    this.aim.set(done?(state.battle.winner==='left'?-.8:.8):0,aimY,0);this.camera.lookAt(this.aim);
    this.bloom.strength=ultimate ? .48 : .28;
    this.keyLight.intensity=ultimate?3.4:4;
    this.backLight.color.set(ultimate ? (state.battle.fighters[ultimate.attacker]==='ronin'?'#e8587d':'#ab91ff') : '#a4b5ff');
    this.floorMaterial.uniforms['uPower'].value=ultimate?Math.sin(clamp(age/2.8,0,1)*Math.PI):0;
    for(const side of ['left','right'] as const) {
      const rig=this.rigs[side]!,direction=side==='left'?1:-1,base=-direction*2.35;
      rig.root.visible=true;rig.root.position.set(base,0,0);rig.root.scale.set(direction,1,1);rig.root.rotation.set(0,0,0);
      rig.body.position.y=1.15+Math.sin(t*2.5+(side==='right'?1:0))*.025;rig.body.rotation.set(0,.18,0);
      rig.head.rotation.set(0,direction*.2,Math.sin(t)*.015);rig.arm.rotation.set(-.12,0,-.18);rig.offArm.rotation.set(-.1,0,.18);
      animateCloth(rig,t,ultimate?1:0);
      rig.cloth.rotation.x=Math.sin(t*2)*.035;rig.weapon.rotation.set(0,0,0);
      rig.legs[0].rotation.set(.05,0,0);rig.legs[1].rotation.set(-.05,0,0);
      rig.halo.rotation.z=t*.15;rig.glow.emissiveIntensity=state.battle.enraged===side?2.2+Math.sin(t*5)*.4:1.35;
      const defeated=state.started&&health[side]<=0;
      if(state.started&&time<1300) {
        const p=smooth(time/1100);rig.root.position.x=base-direction*(1-p)*3.2;
        const walk=Math.sin(time*.018)*(1-p);rig.legs[0].rotation.x=walk*.5;rig.legs[1].rotation.x=-walk*.5;
      }
      if(turn&&!defeated&&!this.motion.matches)this.pose(rig,turn,time,base,direction);
      if(defeated&&last) {
        const fall=smooth((time-last.hitAt)/750),deathClass=last.move==='ultimate'?state.battle.fighters[last.attacker]:null;
        if(deathClass==='mage'){rig.root.scale.set(direction*(1-fall),1+fall*1.5,1-fall);rig.root.position.y=fall;rig.root.rotation.z=direction*fall*1.8;}
        else if(deathClass==='knight'){rig.root.scale.setScalar(1-fall);rig.root.scale.x*=direction;rig.root.position.y=fall*1.5;}
        else {rig.root.rotation.z=-direction*fall*1.5;rig.root.position.y=-fall*.08;rig.root.position.x=base-direction*fall*.5;}
        if(done)rig.root.visible=false;
      }
      if(done&&!defeated){rig.root.position.x=-direction*.8;rig.arm.rotation.z=-2.55;rig.weapon.rotation.z=.2;rig.body.rotation.y=Math.sin(t*.4)*.12;}
    }
    if(turn&&!done&&!this.motion.matches) {
      const from=turn.attacker==='left'?-2.35:2.35,to=-from;
      if(ultimate)this.effects.ultimate(state.battle.fighters[turn.attacker],from,to,age*2.8/Math.max(.001,(turn.hitAt-turn.at)/1000));
      else this.effects.combat(state.battle.fighters[turn.attacker],turn.move,from,to,(time-turn.at)/turnLength(turn),(turn.hitAt-turn.at)/turnLength(turn),!!turn.defended&&turn.move!=='special');
    }
    this.canvas.dataset['ultimate']=ultimate&&!done?state.battle.fighters[ultimate.attacker]:'';
    this.canvas.dataset['elapsed']=String(time);
    this.canvas.dataset['triangles']=String(this.renderer.info.render.triangles);
    this.canvas.dataset['fighters']=`${state.battle.fighters.left},${state.battle.fighters.right}`;
  }

  private pose(rig:FighterRig,turn:DuelTurn,time:number,base:number,direction:number):void {
    const age=time-turn.at,windup=turn.hitAt-turn.at,hit=age-windup;
    if(turn.attacker!==rig.side) {
      if(hit>=0&&hit<650&&turn.move!=='heal') {
        const recoil=Math.sin(clamp(hit/650,0,1)*Math.PI);rig.root.position.x=base-direction*recoil*.4;
        rig.body.rotation.z=-recoil*.23;rig.head.rotation.z=-recoil*.18;
      }
      if(turn.defended&&age>windup-200&&age<windup+500){rig.offArm.rotation.z=-1.05;rig.body.rotation.y=.25;}
      return;
    }
    if(turn.move==='heal') {rig.arm.rotation.z=-.9;rig.offArm.rotation.z=.9;rig.body.position.y+=Math.sin(age/1500*Math.PI)*.15;return;}
    if(turn.move==='ultimate') {
      const p=clamp(age/windup,0,1),release=smooth(hit/240),settle=1-smooth(hit/950);
      const charge=smooth(p/.6);
      rig.head.rotation.x=-charge*.15;
      if(rig.character==='knight') {
        rig.arm.rotation.z=-charge*2.75+release*3.3;
        rig.offArm.rotation.z=-.25-charge*.5;
        rig.body.rotation.z=-charge*.1+release*.27*settle;
        rig.root.position.y=Math.sin(p*Math.PI)*.16;
        rig.legs[0].rotation.x=charge*.24;rig.legs[1].rotation.x=-charge*.24;
      } else if(rig.character==='mage') {
        rig.root.position.y=Math.sin(clamp(age/(windup+900),0,1)*Math.PI)*.65;
        rig.arm.rotation.z=-charge*2.2+release*.7;
        rig.offArm.rotation.z=charge*1.85-release*.45;
        rig.body.rotation.y=.18+Math.sin(p*Math.PI)*.3;
        rig.legs[0].rotation.x=charge*.2;rig.legs[1].rotation.x=-charge*.3;
      } else {
        const draw=smooth((p-.48)/.12),dash=smooth((p-.68)/.12),returning=smooth((p-.89)/.11);
        rig.root.position.x=base+direction*(dash-returning)*4.5;
        rig.root.position.z=-Math.sin(dash*Math.PI)*.5;
        rig.body.position.y-=.17*(1-draw)+.1*Math.sin(p*Math.PI);
        rig.body.rotation.z=.13-draw*.3+returning*.17;
        rig.body.rotation.y=.18+Math.sin(dash*Math.PI)*1.7;
        rig.arm.rotation.z=-.6-draw*1.7+returning*1.4;
        rig.weapon.rotation.z=-1.2+draw*1.8-returning*.6;
        rig.offArm.rotation.z=.65-draw*.9;
        rig.legs[0].rotation.x=(dash-returning)*.8;rig.legs[1].rotation.x=-(dash-returning)*.7;
      }
      return;
    }
    const anticipation=smooth(age/windup),recovery=1-smooth(hit/Math.max(1,turnLength(turn)-windup));
    const approach=smooth((age/windup-.3)/.7),strike=hit<0?approach:recovery;
    const mage=rig.character==='mage';
    rig.root.position.x=base+direction*(mage?.25:2.25)*strike;
    rig.body.rotation.z=hit<0?.12*anticipation:-.14*recovery;
    // The weapon extends along local +Y: a negative Z swing lands toward the rival.
    rig.arm.rotation.z=hit<0?.6*anticipation-2.15*smooth((age/windup-.65)/.35):-1.55*recovery;
    rig.weapon.rotation.z=hit<0?-.12*anticipation:-.16*recovery;
    rig.offArm.rotation.z=-.2-strike*.45;
    rig.body.rotation.y=.18+Math.sin(strike*Math.PI)*.35;
    rig.legs[0].rotation.x=strike*.45;rig.legs[1].rotation.x=-strike*.5;
    rig.cloth.rotation.x-=strike*.16;
    if(turn.move==='special'&&rig.character==='knight')rig.root.position.y=Math.sin(clamp(age/turnLength(turn),0,1)*Math.PI)*.45;
    if(turn.move==='special'&&rig.character==='ronin')rig.root.position.z=-Math.sin(strike*Math.PI)*.45;

  }

  dispose():void {
    if(this.dead)return;this.dead=true;clearTimeout(this.timer);
    this.observer.disconnect();this.motion.removeEventListener('change',this.motionChanged);this.canvas.removeEventListener('webglcontextlost',this.contextLost);
    this.envMap.dispose();disposeObject(this.scene);for(const pass of this.composer.passes)pass.dispose();this.composer.dispose();
    this.keyLight.shadow.dispose();this.renderer.dispose();this.renderer.forceContextLoss();
  }
}

export function healthAt(battle:DuelBattle,time:number,started:boolean):Record<DuelSide,number> {
  const max=battle.maxHp??100,health={left:max,right:max};
  if(started)for(const turn of battle.turns) {
    if(time<turn.hitAt)break;
    if(turn.move==='heal')health[turn.attacker]=Math.min(max,health[turn.attacker]+(turn.heal??0));
    else {const defender=otherSide(turn.attacker);health[defender]=Math.max(0,health[defender]-turn.damage);if(turn.comboHeal&&time>=turn.hitAt+COMBO_HEAL.delay)health[defender]=Math.min(max,health[defender]+turn.comboHeal);}
  }
  return health;
}

function disposeObject(root:T.Object3D):void {
  const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>();
  root.traverse(object=>{if(object instanceof T.Mesh||object instanceof T.Points){geometries.add(object.geometry);for(const material of Array.isArray(object.material)?object.material:[object.material])materials.add(material);}});
  for(const geometry of geometries)geometry.dispose();for(const material of materials)material.dispose();
}
