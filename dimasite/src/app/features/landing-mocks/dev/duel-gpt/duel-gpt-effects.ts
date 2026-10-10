import * as T from 'three';
import type { DuelCharacter } from '../../../widgets/duel/duel-battle';

const clamp = T.MathUtils.clamp;
export class DuelEffects {
  readonly root = new T.Group();
  private readonly judgment = new T.Group();
  private readonly singularity = new T.Group();
  private readonly bloodMoon = new T.Group();
  private readonly sword = new T.Group();
  private readonly beam: T.Mesh;
  private readonly core: T.Mesh;
  private readonly disk: T.Mesh;
  private readonly diskMaterial: T.ShaderMaterial;
  private readonly rings: T.Mesh[] = [];
  private readonly cuts: T.Mesh[] = [];
  private readonly echoes: T.Group[] = [];
  private readonly shards: T.Mesh[] = [];
  private readonly feathers: T.Mesh[] = [];
  private readonly shock: T.Mesh;
  private readonly slash: T.Mesh;
  private readonly projectile: T.Mesh;
  private readonly ward: T.Mesh;
  private readonly heal: T.Mesh;
  private readonly particles: T.Points;
  private readonly data = new Float32Array(180*3);
  private readonly light = new T.PointLight('#d0bcff',0,12,2);

  constructor() {
    const add=(parent:T.Object3D,geo:T.BufferGeometry,mat:T.Material,x=0,y=0,z=0)=>{
      const m=new T.Mesh(geo,mat);m.position.set(x,y,z);parent.add(m);return m;
    };
    const radiant=(color:string,opacity=1)=>new T.MeshBasicMaterial({color,transparent:true,opacity,side:T.DoubleSide,depthWrite:false,blending:T.AdditiveBlending,toneMapped:false});
    const gold=radiant('#e9b86b'),white=radiant('#ffe6ab'),violet=radiant('#ac8dff'),red=radiant('#ff315d');
    this.root.add(this.judgment,this.singularity,this.bloodMoon,this.light);
    // A celestial seal and feathered wings frame the falling sword.
    for(let i=0;i<3;i++) {
      const r=add(this.judgment,new T.TorusGeometry(1.05+i*.24,.018,5,72),gold,0,3.55,-.35);
      this.rings.push(r);
    }
    for(let side=-1;side<=1;side+=2)for(let i=0;i<8;i++) {
      const f=add(this.judgment,new T.ConeGeometry(.11,1.15-i*.075,4),radiant('#e5cfa5',.65),side*(.4+i*.21),3.2-i*.11,-.5);
      f.rotation.z=side*(-.5-i*.095);this.feathers.push(f);
    }
    this.judgment.add(this.sword);
    const blade=add(this.sword,new T.CylinderGeometry(.02,.22,3.5,4),white,0,1.7,0);blade.rotation.z=Math.PI;
    add(this.sword,new T.BoxGeometry(1.05,.16,.2),gold,0,3.49,0);
    add(this.sword,new T.CylinderGeometry(.07,.07,.7,8),white,0,3.86,0);
    this.beam=add(this.judgment,new T.CylinderGeometry(.11,.38,10,20,1,true),radiant('#ffe8ac',.3),0,4,0);
    // An actual depthful accretion disk, lens rings and orbiting fragments.
    this.core=add(this.singularity,new T.SphereGeometry(.65,32,24),new T.MeshBasicMaterial({color:'#020109'}),0,2,0);
    this.disk=add(this.singularity,new T.TorusGeometry(.94,.09,8,80),violet,0,2,0);
    this.disk.rotation.x=.95;
    this.diskMaterial=new T.ShaderMaterial({transparent:true,side:T.DoubleSide,depthWrite:false,blending:T.AdditiveBlending,toneMapped:false,uniforms:{uTime:{value:0}},
      vertexShader:'varying vec2 vPoint;void main(){vPoint=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:`varying vec2 vPoint;uniform float uTime;void main(){float r=length(vPoint);float a=atan(vPoint.y,vPoint.x);
      float edge=smoothstep(.65,.73,r)*(1.-smoothstep(1.3,1.6,r));
      float ribbons=pow(.5+.5*sin(r*62.-a*3.+uTime*9.),3.);
      float spiral=.5+.5*sin(a*5.-r*19.+uTime*5.);float fire=exp(-abs(r-.73)*16.);
      vec3 color=mix(vec3(.32,.14,.8),vec3(1.,.3,.68),spiral);color=mix(color,vec3(1.,.72,.35),fire);
      gl_FragColor=vec4(color*(.6+ribbons*.9+fire*.8),edge*(.18+ribbons*.45));}`});
    const accretion=add(this.singularity,new T.RingGeometry(.65,1.6,80,12),this.diskMaterial,0,2,0);
    accretion.rotation.set(1.08,.1,-.25);
    for(let i=0;i<4;i++) {
      const r=add(this.singularity,new T.TorusGeometry(.69+i*.12,.013,4,64),radiant(i%2?'#ffb6ff':'#a082ff',.65),0,2,0);
      r.rotation.set(.4+i*.37,.2+i*.5,0);this.rings.push(r);
    }
    for(let i=0;i<26;i++) {
      const s=add(this.root,new T.TetrahedronGeometry(.09+(i%4)*.024),new T.MeshStandardMaterial({color:'#5e577d',metalness:.7,roughness:.4,emissive:'#6f4aaf',emissiveIntensity:.5}));
      this.shards.push(s);
    }
    const moon=add(this.bloodMoon,new T.SphereGeometry(1.22,32,24),radiant('#bd163c'),0,4.05,-2.6);
    add(moon,new T.TorusGeometry(1.28,.025,5,64),red);
    add(moon,new T.SphereGeometry(1.18,24,16),new T.MeshBasicMaterial({color:'#0b0715'}),.36,.15,.48);
    for(let i=0;i<12;i++) {
      const cut=add(this.bloodMoon,new T.PlaneGeometry(8,.035+(i%3)*.015),radiant(i%3?'#ff305b':'#fff3fa',.8),0,1.6,0);
      cut.rotation.z=(i*.91)%Math.PI;cut.rotation.y=(i%3-1)*.27;this.cuts.push(cut);
      add(cut,new T.PlaneGeometry(8,.22),radiant('#ff2455',.1));
    }
    for(let i=0;i<6;i++) {
      const ghost=new T.Group();this.bloodMoon.add(ghost);this.echoes.push(ghost);
      const mat=radiant('#ff315d',.14);
      add(ghost,new T.CylinderGeometry(.3,.35,.8,6),mat,0,1.45,0);
      add(ghost,new T.SphereGeometry(.28,12,8),mat,0,2.08,0);
      add(ghost,new T.ConeGeometry(.58,.22,16),mat,0,2.35,0);
      const sword=add(ghost,new T.BoxGeometry(1.8,.023,.025),radiant('#ffb8ce',.4),.9,1.3,.3);sword.rotation.z=-.35;
    }
    this.shock=add(this.root,new T.TorusGeometry(1,.06,5,64),radiant('#ffd899'));this.shock.rotation.x=-Math.PI/2;
    this.slash=add(this.root,new T.TorusGeometry(.9,.045,4,32,Math.PI*1.2),radiant('#d3bcff'));
    this.projectile=add(this.root,new T.IcosahedronGeometry(.17,1),violet);
    this.ward=add(this.root,new T.IcosahedronGeometry(.95,1),new T.MeshBasicMaterial({color:'#a9bdff',wireframe:true,transparent:true,opacity:.3,depthWrite:false}));
    this.heal=add(this.root,new T.TorusGeometry(.75,.027,4,48),radiant('#8cffcc'));this.heal.rotation.x=-Math.PI/2;
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.BufferAttribute(this.data,3));
    this.particles=new T.Points(geo,new T.PointsMaterial({color:'#e6bfff',size:.045,transparent:true,opacity:.8,blending:T.AdditiveBlending,depthWrite:false,toneMapped:false}));
    this.particles.frustumCulled=false;this.root.add(this.particles);
    this.hide();
  }

  hide():void {
    this.judgment.visible=this.singularity.visible=this.bloodMoon.visible=false;
    this.shock.visible=this.slash.visible=this.projectile.visible=this.ward.visible=this.heal.visible=this.particles.visible=false;
    for(const s of this.shards)s.visible=false;
    this.light.intensity=0;
  }

  combat(character:DuelCharacter,move:string,from:number,to:number,progress:number,hit:number,defended:boolean):void {
    if(move==='heal') {
      this.heal.visible=true;this.heal.position.set(from,.08+progress*1.7,0);this.heal.scale.setScalar(.8+Math.sin(progress*Math.PI)*.4);
      this.light.position.set(from,1.7,.4);this.light.color.set('#8cffcc');this.light.intensity=2*Math.sin(progress*Math.PI);
      return;
    }
    const direction=Math.sign(to-from),p=clamp(progress/hit,0,1);
    if(character==='mage'&&progress<hit+.12) {
      this.projectile.visible=true;this.projectile.position.set(from+(to-from)*Math.pow(p,3),1.5+Math.sin(p*Math.PI)*.35,.35);
      this.projectile.scale.setScalar(move==='special'?2.3:1);
      this.projectile.rotation.set(progress*10,progress*14,0);
    } else if(progress>hit-.16&&progress<hit+.18) {
      this.slash.visible=true;this.slash.position.set(to-direction*.5,1.45,.5);
      this.slash.rotation.set(.3,direction*.5,(progress-hit)*-8*direction);
      this.slash.scale.setScalar(move==='special'?1.4:.8);
    }
    if(defended&&progress>hit-.1&&progress<hit+.24) {
      this.ward.visible=true;this.ward.position.set(to,1.2,0);this.ward.rotation.y=progress*3;
    }
    if(progress>=hit&&progress<hit+.32) {
      const burst=(progress-hit)/.32;this.shock.visible=true;this.shock.position.set(to,.11,0);
      this.shock.scale.setScalar(.15+burst*1.9);(this.shock.material as T.MeshBasicMaterial).opacity=1-burst;
      this.light.position.set(to,1.1,1);this.light.intensity=6*(1-burst);this.light.color.set('#d4b4ff');
    }
  }

  ultimate(character:DuelCharacter,from:number,to:number,age:number):void {
    const charge=clamp(age/2.8,0,1),after=age-2.8,fade=1-clamp(after/1.8,0,1);
    this.light.position.set(to,2.2,1);this.light.intensity=(after<0?charge*5:fade*18);
    this.light.color.set(character==='knight'?'#ffd693':character==='mage'?'#a988ff':'#ff2754');
    const group=character==='knight'?this.judgment:character==='mage'?this.singularity:this.bloodMoon;
    group.visible=true;group.position.x=to;
    this.particles.visible=true;
    (this.particles.material as T.PointsMaterial).color.copy(this.light.color);
    if(character==='knight') {
      this.judgment.scale.setScalar(.65+charge*.45);
      this.sword.position.y=after<0?1.3-charge*.9:Math.max(-2.5,.4-Math.pow(after*9,2));
      this.sword.rotation.y=charge*.15;
      this.beam.visible=after>-.12;this.beam.scale.set(1+Math.max(0,after)*3,1,1+Math.max(0,after)*3);
      (this.beam.material as T.MeshBasicMaterial).opacity=after<0?.1:.55*fade;
      for(let i=0;i<3;i++)this.rings[i].rotation.z=age*(i%2?-.3:.3);
      for(let i=0;i<this.feathers.length;i++)this.feathers[i].rotation.y=Math.sin(age*2+i*.2)*.2;
    } else if(character==='mage') {
      const scale=after<0?.12+Math.pow(charge,2)*1.8:Math.max(.02,1.92-after*1.7);
      this.singularity.scale.setScalar(scale);this.disk.rotation.z=age*3;
      this.diskMaterial.uniforms['uTime'].value=age;
      this.core.scale.setScalar(1+Math.sin(age*13)*.025);
      for(let i=3;i<7;i++)this.rings[i].rotation.z=age*(i%2?2:-2);
    } else {
      this.bloodMoon.position.x=0;
      for(let i=0;i<this.cuts.length;i++) {
        const onset=1.45+i*.085,local=age-onset;
        const opacity=local>0&&local<.26?Math.sin(local/.26*Math.PI):after>=0?fade*.2:0;
        this.cuts[i].visible=opacity>0; (this.cuts[i].material as T.MeshBasicMaterial).opacity=opacity;
        this.cuts[i].position.set(to,(i%4)*.46+.5,.55+(i%3)*.12);
        this.cuts[i].scale.x=.35+clamp(local/.12,0,1)*.65;
      }
      for(let i=0;i<this.echoes.length;i++) {
        const local=age-1.3-i*.12,a=i*Math.PI/3;
        this.echoes[i].visible=local>0&&local<.85;
        this.echoes[i].position.set(to+Math.cos(a)*1.3,Math.sin(a)*.15,Math.sin(a)*1.1);
        this.echoes[i].rotation.y=-a;
        this.echoes[i].scale.setScalar(.9+clamp(local/.5,0,1)*.15);
      }
    }
    if(after>=0) {
      this.shock.visible=true;this.shock.position.set(to,.09,0);this.shock.scale.setScalar(.5+after*4);
      (this.shock.material as T.MeshBasicMaterial).color.copy(this.light.color);
      (this.shock.material as T.MeshBasicMaterial).opacity=fade*.85;
    }
    for(let i=0;i<this.shards.length;i++) {
      const m=this.shards[i],a=i*2.399+age*(character==='mage'?1.5:.14);
      m.visible=true;const r=character==='mage'?(after<0?2.5-charge*.9:Math.max(0,1.6-after*2)):after<0?1.15:1.15+after*(1+i%3);
      m.position.set(to+Math.cos(a)*r,after<0?.22+charge*(i%4)*.24:Math.max(.06,.6+Math.sin(i)*after*3-after*after*2),Math.sin(a)*r);
      m.rotation.set(age+i,age*.6+i,age*.4);m.scale.setScalar(fade);
    }
    for(let i=0;i<180;i++) {
      const a=i*2.399+age*(character==='mage'?3:.25),n=(i%30)/30;
      const r=character==='mage'?(.1+(1-charge)*3.2+n*2)*(after>0?fade:1):after<0?.6+n*1.2:.4+after*(1+n*3);
      this.data[i*3]=to+Math.cos(a)*r;
      this.data[i*3+1]=character==='knight'?n*5+age*.3:character==='mage'?2+Math.sin(a*.7)*r*.3:.3+n*2.5;
      this.data[i*3+2]=Math.sin(a)*r;
    }
    this.particles.geometry.attributes['position'].needsUpdate=true;
    (this.particles.material as T.PointsMaterial).opacity=fade*.8;
  }
}
