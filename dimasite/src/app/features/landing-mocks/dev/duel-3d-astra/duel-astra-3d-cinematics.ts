import * as T from 'three';
import type { DuelCharacter } from '../../../widgets/duel/duel-battle';
const clamp=T.MathUtils.clamp;
const ease=(v:number)=>{v=clamp(v,0,1);return v*v*(3-2*v);};

/** Reusable, deterministic VFX: no per-frame meshes, timers, randomness, or texture downloads. */
export class AstraCinematics {
  readonly root=new T.Group();
  private readonly wings=new T.Group();
  private readonly feathers:T.Mesh[]=[];
  private readonly seals:T.Mesh[]=[];
  private readonly lens:T.Mesh;
  private readonly lensMaterial:T.ShaderMaterial;
  private readonly ribbons:T.Mesh[]=[];
  private readonly shockwaves:T.Mesh[]=[];
  private readonly rays:T.InstancedMesh;
  private readonly rayMaterial:T.MeshBasicMaterial;
  private readonly dummy=new T.Object3D();
  private readonly finisher:T.Mesh;
  private readonly finisherGlow:T.Mesh;
  private readonly accent=new T.Color();

  constructor() {
    const radiant=(color:string,opacity=1)=>new T.MeshBasicMaterial({color,transparent:true,opacity,side:T.DoubleSide,blending:T.AdditiveBlending,depthWrite:false,toneMapped:false});
    const add=(p:T.Object3D,g:T.BufferGeometry,m:T.Material)=>{const mesh=new T.Mesh(g,m);p.add(mesh);return mesh;};
    this.root.add(this.wings);
    for(const side of [-1,1])for(let i=0;i<11;i++) {
      const shape=new T.Shape();shape.moveTo(0,0);shape.bezierCurveTo(.12,.35,.18,.95,0,1.45);shape.bezierCurveTo(-.1,.8,-.15,.28,0,0);
      const feather=add(this.wings,new T.ExtrudeGeometry(shape,{depth:.018,bevelEnabled:true,bevelSize:.014,bevelThickness:.012,bevelSegments:2,steps:1}),new T.MeshStandardMaterial({color:'#fff0cc',emissive:'#d4ad67',emissiveIntensity:.55,metalness:.3,roughness:.3,transparent:true}));
      feather.userData['side']=side;feather.userData['index']=i;this.feathers.push(feather);
    }
    for(let i=0;i<3;i++) {
      const seal=add(this.root,new T.RingGeometry(.96,1,96),radiant('#ffd99a',.8));this.seals.push(seal);
      const glyphs=new T.InstancedMesh(new T.BoxGeometry(.02,.12,.02),radiant('#ffeac7'),24),m=new T.Object3D();
      for(let j=0;j<24;j++){const a=j*Math.PI/12;m.position.set(Math.cos(a)*1.11,Math.sin(a)*1.11,0);m.rotation.z=a;m.updateMatrix();glyphs.setMatrixAt(j,m.matrix);}
      seal.add(glyphs);
    }
    this.lensMaterial=new T.ShaderMaterial({transparent:true,depthWrite:false,side:T.FrontSide,blending:T.AdditiveBlending,toneMapped:false,
      uniforms:{uColor:{value:new T.Color('#9caaff')},uOpacity:{value:1}},
      vertexShader:`varying vec3 vNormal;varying vec3 vView;void main(){vec4 p=modelViewMatrix*vec4(position,1.);vNormal=normalize(normalMatrix*normal);vView=-p.xyz;gl_Position=projectionMatrix*p;}`,
      fragmentShader:`varying vec3 vNormal;varying vec3 vView;uniform vec3 uColor;uniform float uOpacity;void main(){float f=pow(1.-abs(dot(normalize(vNormal),normalize(vView))),3.);gl_FragColor=vec4(uColor*(1.+f),f*uOpacity);}`});
    this.lens=add(this.root,new T.SphereGeometry(1,48,32),this.lensMaterial);
    for(let i=0;i<5;i++) {
      const points=[];for(let j=0;j<=100;j++){const a=j/100*Math.PI*2;points.push(new T.Vector3(Math.cos(a)*(1.3+i*.16),Math.sin(a*3+i)*.12,Math.sin(a)*(1.3+i*.16)));}
      const ribbon=add(this.root,new T.TubeGeometry(new T.CatmullRomCurve3(points),100,.012+i*.003,5,false),radiant(i%2?'#f6b7e5':'#9baaff',.8));this.ribbons.push(ribbon);
    }
    for(let i=0;i<3;i++)this.shockwaves.push(add(this.root,new T.TorusGeometry(1,.018+i*.006,8,128),radiant('#ffe5ac')));
    this.rayMaterial=radiant('#ffe3a8');this.rays=new T.InstancedMesh(new T.ConeGeometry(.016,1,4),this.rayMaterial,96);this.rays.frustumCulled=false;this.root.add(this.rays);
    this.finisher=add(this.root,new T.PlaneGeometry(14,.025),radiant('#fff1de'));
    this.finisherGlow=add(this.finisher,new T.PlaneGeometry(14,.24),radiant('#ff3865',.3));
    this.hide();
  }
  hide():void {for(const child of this.root.children)child.visible=false;}
  update(character:DuelCharacter,from:number,to:number,age:number):void {
    const charge=clamp(age/2.8,0,1),after=age-2.8,fade=1-ease(after/1.5),direction=Math.sign(to-from);
    this.accent.set(character==='knight'?'#ffe0a2':character==='mage'?'#b7a5ff':'#ff547e');
    if(character==='knight') {
      this.wings.visible=true;this.wings.position.set(from,1.55,-.35);this.wings.scale.setScalar((.4+ease(charge/.7)*.6)*fade);
      for(const feather of this.feathers) {
        const side=feather.userData['side'],i=feather.userData['index'],spread=ease(charge/.65);
        feather.position.set(side*(.15+i*.12*spread),.4-i*.056,-i*.035);
        feather.rotation.set(-.2+Math.sin(age*2+i*.3)*.09,side*.2,side*(-.35-i*.082)*spread);
        feather.scale.y=1-i*.044;
      }
      for(let i=0;i<this.seals.length;i++) {
        const seal=this.seals[i];seal.visible=true;seal.position.set(to,.08+i*1.35,0);seal.rotation.set(-Math.PI/2,0,age*(i%2?-1:1)*.3);
        seal.scale.setScalar((.35+ease(charge)*(.9+i*.16))*fade);
      }
    } else if(character==='mage') {
      const scale=after<0?.12+ease(charge)*1.65:Math.max(.01,1.77*(1-ease(after/.65)));
      this.lens.visible=true;this.lens.position.set(to,2,0);this.lens.scale.setScalar(scale);
      this.lensMaterial.uniforms['uColor'].value.copy(this.accent);this.lensMaterial.uniforms['uOpacity'].value=.6*fade;
      for(let i=0;i<this.ribbons.length;i++) {
        const r=this.ribbons[i];r.visible=true;r.position.copy(this.lens.position);r.scale.setScalar(scale);
        r.rotation.set(.4+i*.5,age*(i%2?-.65:.65),age*.25+i);
      }
    } else {
      const strike=ease((age-2.67)/.13),dissolve=1-ease(after/.7);
      this.finisher.visible=age>2.67&&after<.7;this.finisher.position.set(0,1.45,.9);
      this.finisher.rotation.z=direction*-.13;this.finisher.scale.set(strike,Math.max(.05,dissolve),1);
      (this.finisher.material as T.MeshBasicMaterial).opacity=dissolve;
      this.finisherGlow.scale.y=1+Math.max(0,after)*12;
    }
    if(after>=0&&after<1.6) {
      for(let i=0;i<this.shockwaves.length;i++) {
        const wave=this.shockwaves[i],p=Math.max(0,after-i*.07);wave.visible=p>0;wave.position.set(to,.06+i*.02,0);
        wave.rotation.set(-Math.PI/2+i*.06,0,i*.3);wave.scale.setScalar(.3+p*(4.3-i*.6));
        const mat=wave.material as T.MeshBasicMaterial;mat.color.copy(this.accent);mat.opacity=fade*(1-i*.2);
      }
    }
    this.rays.visible=age>.4&&after<1.5;this.rayMaterial.color.copy(this.accent);this.rayMaterial.opacity=fade*.8;
    for(let i=0;i<96;i++) {
      const a=i*2.399,seed=(i%17)/17,before=after<0;
      const radius=before?(character==='mage'?2.8-charge*1.1:.8+seed*1.2):.4+after*(2+seed*5);
      const y=before?(i%13)/13*3.1:.5+after*(1+seed*4)-after*after*2;
      this.dummy.position.set(to+Math.cos(a+age*.4)*radius,Math.max(.06,y),Math.sin(a+age*.4)*radius);
      this.dummy.rotation.set(seed*2,a,character==='knight'&&before?0:-a);
      this.dummy.scale.setScalar(before?.3+charge*.4:fade);this.dummy.scale.y*=before?.4:1+after;
      this.dummy.updateMatrix();this.rays.setMatrixAt(i,this.dummy.matrix);
    }
    this.rays.instanceMatrix.needsUpdate=true;
  }
}
