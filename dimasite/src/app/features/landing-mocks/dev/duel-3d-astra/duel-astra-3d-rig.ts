import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DuelCharacter, DuelSide } from '../../../widgets/duel/duel-battle';

export interface FighterRig {
  root:T.Group; body:T.Group; head:T.Group; arm:T.Group; offArm:T.Group;
  legs:T.Group[]; cloth:T.Group; weapon:T.Group; halo:T.Mesh;
  glow:T.MeshStandardMaterial; character:DuelCharacter; side:DuelSide;
  fabric:T.Mesh; fabricRest:Float32Array; ornaments:T.Group;
}

/** Astra's sculpted, articulated models. Decorative meshes are batched per joint/material. */
export function fighterRig(character:DuelCharacter,side:DuelSide,enraged:boolean):FighterRig {
  const root=new T.Group(),body=new T.Group(),head=new T.Group(),arm=new T.Group(),offArm=new T.Group();
  const cloth=new T.Group(),weapon=new T.Group(),ornaments=new T.Group();
  const tint=enraged?'#ff496c':side==='left'?'#acbdff':'#ffbc88';
  const steel=new T.MeshPhysicalMaterial({color:'#ccd7e4',metalness:.72,roughness:.27,clearcoat:.6});
  const dark=new T.MeshPhysicalMaterial({color:character==='ronin'?'#282535':'#202b43',metalness:.55,roughness:.3,clearcoat:.7});
  const gold=new T.MeshStandardMaterial({color:'#d8b67b',metalness:.78,roughness:.28});
  const ivory=new T.MeshStandardMaterial({color:'#f0e8d5',metalness:.3,roughness:.35});
  const textile=new T.MeshStandardMaterial({color:character==='ronin'?'#683148':side==='left'?'#404b86':'#78523e',roughness:.93,side:T.DoubleSide});
  const glow=new T.MeshStandardMaterial({color:tint,emissive:tint,emissiveIntensity:1.7,roughness:.28,metalness:.3});
  const skin=new T.MeshStandardMaterial({color:'#cba38a',roughness:.83});
  const mesh=(p:T.Object3D,g:T.BufferGeometry,m:T.Material,x=0,y=0,z=0,sx=1,sy=1,sz=1)=>{
    const o=new T.Mesh(g,m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);o.castShadow=true;o.receiveShadow=true;p.add(o);return o;
  };
  const box=(p:T.Object3D,m:T.Material,x:number,y:number,z:number,w:number,h:number,d:number)=>mesh(p,new RoundedBoxGeometry(w,h,d,2,Math.min(w,h,d)*.22),m,x,y,z);
  const sphere=(p:T.Object3D,m:T.Material,x:number,y:number,z:number,r:number,sx=1,sy=1,sz=1)=>mesh(p,new T.SphereGeometry(r,24,16),m,x,y,z,sx,sy,sz);
  const tube=(p:T.Object3D,m:T.Material,points:number[][],radius=.012)=>mesh(p,new T.TubeGeometry(new T.CatmullRomCurve3(points.map(v=>new T.Vector3(...v as [number,number,number]))),24,radius,6,false),m);
  root.add(body);body.position.y=1.15;body.add(head,arm,offArm,cloth,ornaments);head.position.y=1.12;
  arm.position.set(.49,.7,0);offArm.position.set(-.49,.7,0);arm.add(weapon);weapon.position.set(0,-.67,.13);
  const legs:T.Group[]=[];
  for(const x of [-.23,.23]) {
    const leg=new T.Group();leg.position.set(x,.02,0);body.add(leg);legs.push(leg);
    mesh(leg,new T.CapsuleGeometry(.135,.32,8,16),textile,0,-.26,0);
    sphere(leg,character==='knight'?ivory:dark,0,-.51,.07,.16,1,.8,1.1);
    box(leg,character==='knight'?steel:dark,0,-.77,0,.255,.42,.27);
    box(leg,gold,0,-.75,.145,.035,.3,.028);
    box(leg,dark,0,-1,.09,.29,.17,.44);
    for(let i=0;i<3;i++)box(leg,gold,0,-.91+i*.07,.16,.25,.018,.018);
  }
  for(const limb of [arm,offArm]) {
    mesh(limb,new T.CapsuleGeometry(.12,.34,8,16),textile,0,-.25,0);
    sphere(limb,character==='knight'?ivory:dark,0,0,0,.245,1.15,.8,1.05);
    sphere(limb,gold,0,-.43,.04,.125,1,.6,1);
    box(limb,character==='knight'?steel:dark,0,-.54,.035,.23,.29,.25);
    for(let i=0;i<3;i++)box(limb,gold,0,-.43-i*.08,.17,.19,.016,.018);
    sphere(limb,character==='mage'?skin:dark,0,-.73,.065,.12,1,1.1,1);
    for(let i=0;i<3;i++)box(limb,character==='knight'?steel:skin,-.065+i*.06,-.79,.12,.038,.08,.047);
  }
  // A subdivided cloth surface, animated from its rest coordinates (scrubbing is reversible).
  const fabricGeo=new T.PlaneGeometry(character==='mage'?1.08:.91,1.55,16,22);
  const pos=fabricGeo.attributes['position'];
  for(let i=0;i<pos.count;i++) {
    const y=pos.getY(i),u=(.775-y)/1.55,x=pos.getX(i)*(1+u*.22);
    pos.setXYZ(i,x,y,Math.cos(x*20)*.045*u-u*u*.23);
  }
  fabricGeo.computeVertexNormals();
  const fabric=mesh(cloth,fabricGeo,textile,0,-.04,-.3);cloth.position.y=.18;
  const fabricRest=new Float32Array(pos.array);
  for(const x of [-.46,.46])tube(cloth,gold,[[x,.7,-.3],[x*.99,.2,-.34],[x*1.17,-.65,-.51]],.016);
  const halo=mesh(root,new T.TorusGeometry(.91,.014,8,96),glow,0,.045,0);halo.rotation.x=-Math.PI/2;
  if(character==='knight') {
    sphere(body,steel,0,.43,0,.44,1,1.07,.72);
    for(const x of [-1,1]) {
      const plate=sphere(body,ivory,x*.17,.54,.22,.235,.96,1.05,.42);plate.rotation.z=x*-.2;
      tube(body,gold,[[x*.03,.78,.29],[x*.27,.65,.35],[x*.29,.4,.3],[x*.07,.31,.33]],.019);
      for(let i=0;i<3;i++){const p=box(body,steel,x*.25,.01-i*.13,.22,.29,.19,.1);p.rotation.z=x*.18;}
    }
    for(let i=0;i<3;i++)box(body,dark,0,.14+i*.085,.305,.54-i*.015,.068,.09);
    mesh(body,new T.OctahedronGeometry(.1,0),glow,0,.62,.385,1,1.45,.65);
    box(body,gold,0,.015,0,.78,.09,.56);
    sphere(head,steel,0,0,0,.335,1,1.14,.88);
    sphere(head,dark,0,-.025,.18,.27,1,.48,.55);
    for(const x of [-1,1]) {
      box(head,glow,x*.125,.025,.323,.18,.028,.025).rotation.z=x*.07;
      tube(head,gold,[[x*.28,.04,.24],[x*.24,-.22,.26],[x*.07,-.3,.29]],.022);
      sphere(head,ivory,x*.265,-.11,.15,.11,.6,1.4,1.2);
    }
    box(head,gold,0,.085,.32,.043,.47,.043);
    for(let i=0;i<9;i++) {
      const plume=mesh(head,new T.CapsuleGeometry(.06,.25+i*.013,6,12),textile,0,.35-i*.022,-.02-i*.065);plume.rotation.x=-.45-i*.075;
    }
    for(const limb of [arm,offArm]) {
      for(let i=0;i<3;i++)sphere(limb,i===0?gold:ivory,0,.08-i*.07,0,.265-i*.014,1.2,.28,1.1);
      mesh(limb,new T.OctahedronGeometry(.07),glow,0,.11,.22);
    }
    box(weapon,dark,0,-.12,0,.1,.34,.105);
    for(let i=0;i<6;i++)mesh(weapon,new T.TorusGeometry(.056,.008,5,12),gold,0,-.24+i*.05,0).rotation.x=Math.PI/2;
    tube(weapon,gold,[[-.31,.17,0],[-.22,.08,0],[0,.12,0],[.22,.08,0],[.31,.17,0]],.045);
    mesh(weapon,new T.OctahedronGeometry(.1),glow,0,-.33,0);
    const shape=new T.Shape();shape.moveTo(-.095,.17);shape.lineTo(-.105,1.25);shape.lineTo(0,1.68);shape.lineTo(.105,1.25);shape.lineTo(.095,.17);shape.closePath();
    mesh(weapon,new T.ExtrudeGeometry(shape,{depth:.045,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.016,bevelThickness:.012}),steel,0,0,-.025);
    box(weapon,glow,0,.79,.052,.02,1.13,.012);
    const shield=new T.Shape();shield.moveTo(0,-.58);shield.quadraticCurveTo(-.4,-.3,-.37,.27);shield.quadraticCurveTo(0,.52,.37,.27);shield.quadraticCurveTo(.4,-.3,0,-.58);
    mesh(offArm,new T.ExtrudeGeometry(shield,{depth:.09,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.035,bevelThickness:.025}),gold,-.11,-.39,.27);
    mesh(offArm,new T.ShapeGeometry(shield,24),dark,-.11,-.39,.39,.87,.87,1);
    tube(offArm,ivory,[[-.34,-.2,.41],[-.11,-.32,.43],[.12,-.2,.41]],.028);
    tube(offArm,gold,[[-.33,-.4,.41],[-.11,-.67,.43],[.11,-.4,.41]],.024);
    mesh(offArm,new T.OctahedronGeometry(.115),glow,-.11,-.38,.44,1,1.6,.55);
  } else if(character==='ronin') {
    mesh(body,new T.CylinderGeometry(.35,.41,.82,24),textile,0,.4,0,1,1,.82);
    for(let i=0;i<6;i++) {
      box(body,dark,0,.1+i*.115,.285,.72-i*.03,.095,.13);
      for(const x of [-.23,-.08,.08,.23])box(body,gold,x,.1+i*.115,.36,.022,.045,.018);
    }
    for(const x of [-1,1])for(let i=0;i<4;i++)box(body,dark,x*.3,-.05-i*.1,.16,.24,.09,.26).rotation.z=x*.15;
    box(body,textile,0,.04,.015,.82,.13,.6);
    tube(body,gold,[[-.39,.06,.33],[-.13,.11,.36],[.02,.04,.38],[.18,.1,.35],[.38,.05,.32]],.025);
    sphere(head,skin,0,-.035,.025,.285,1,1.1,.85);
    sphere(head,dark,0,-.13,.19,.235,1,.63,.58);
    for(const x of [-1,1]) {
      box(head,glow,x*.113,.015,.272,.135,.024,.022).rotation.z=x*-.09;
      tube(head,ivory,[[x*.18,-.13,.31],[x*.1,-.2,.325],[x*.025,-.18,.34]],.014);
    }
    const hat=mesh(head,new T.ConeGeometry(.67,.29,64),dark,0,.3,0);
    mesh(head,new T.TorusGeometry(.647,.015,6,80),gold,0,.166,0).rotation.x=Math.PI/2;
    for(let i=0;i<24;i++){const a=i*Math.PI/12;tube(head,gold,[[0,.448,0],[Math.cos(a)*.34,.31,Math.sin(a)*.34],[Math.cos(a)*.64,.169,Math.sin(a)*.64]],.0035);}
    hat.rotation.y=.1;
    box(weapon,dark,0,-.14,0,.095,.39,.09);
    for(let i=0;i<6;i++)box(weapon,ivory,0,-.29+i*.055,.048,.06,.025,.009).rotation.z=i%2?.5:-.5;
    mesh(weapon,new T.TorusGeometry(.112,.022,8,32),gold,0,.065,0,1,.7,1).rotation.x=Math.PI/2;
    tube(weapon,steel,[[0,.12,0],[.025,.65,0],[.09,1.2,0],[.19,1.65,0]],.04);
    tube(weapon,glow,[[.035,.12,.014],[.06,.65,.014],[.125,1.2,.014],[.19,1.65,.014]],.009);
    box(body,dark,-.4,.02,-.2,.11,1.3,.12).rotation.z=-1.08;
    for(const limb of [arm,offArm])for(let i=0;i<3;i++)box(limb,dark,0,.025-i*.08,.1,.38,.07,.27);
  } else {
    const profile=[new T.Vector2(.55,-.57),new T.Vector2(.58,-.5),new T.Vector2(.45,-.2),new T.Vector2(.32,.25),new T.Vector2(.37,.72)];
    mesh(body,new T.LatheGeometry(profile,48),textile,0,.03,0,1,1,.8);
    for(const x of [-1,1]) {
      tube(body,gold,[[x*.31,.71,.19],[x*.19,.35,.3],[x*.16,.05,.29],[x*.34,-.5,.4]],.027);
      for(let i=0;i<6;i++)mesh(body,new T.OctahedronGeometry(.031),gold,x*(.18+i*.025),-.03-i*.08,.34+i*.01);
    }
    box(body,gold,0,.04,.025,.73,.08,.55);
    sphere(head,dark,0,-.005,.025,.3,1,1.13,.86);
    for(const x of [-1,1])box(head,glow,x*.106,.008,.27,.13,.033,.025);
    // Swept, bent hat profile and orbiting astrolabe replace a simple cone.
    const hatProfile=[new T.Vector2(.42,0),new T.Vector2(.31,.21),new T.Vector2(.22,.43),new T.Vector2(.14,.62),new T.Vector2(.025,.88)];
    const hat=mesh(head,new T.LatheGeometry(hatProfile,48),textile,0,.16,0);hat.rotation.z=.18;
    mesh(head,new T.CylinderGeometry(.52,.54,.046,64),dark,0,.15,0);
    mesh(head,new T.TorusGeometry(.52,.018,8,64),gold,0,.15,0).rotation.x=Math.PI/2;
    mesh(head,new T.TorusGeometry(.34,.022,8,48),gold,-.03,.29,0).rotation.x=Math.PI/2;
    mesh(head,new T.OctahedronGeometry(.075),glow,-.04,.34,.325);
    mesh(body,new T.OctahedronGeometry(.12),glow,0,.56,.32,1,1.4,.6);
    tube(body,gold,[[-.28,.71,.24],[-.15,.46,.34],[0,.39,.34],[.15,.46,.34],[.28,.71,.24]],.011);
    mesh(weapon,new T.CylinderGeometry(.035,.05,2.55,16),dark,0,.49,0);
    for(let i=0;i<12;i++)mesh(weapon,new T.TorusGeometry(.049,.011,6,16),gold,0,-.4+i*.15,0).rotation.x=Math.PI/2;
    for(let i=0;i<3;i++) {
      const ring=mesh(weapon,new T.TorusGeometry(.26,.017,8,64),gold,0,1.84,0);ring.rotation.set(i*.7,i*.9,.3);
    }
    mesh(weapon,new T.IcosahedronGeometry(.15,1),glow,0,1.84,0,1,1.35,1);
    for(let i=0;i<5;i++) {
      const a=i*Math.PI*2/5,o=mesh(ornaments,new T.OctahedronGeometry(.047),glow,Math.cos(a)*.55,.72+Math.sin(a)*.18,-.1);
      o.rotation.z=a;
    }
  }
  for(const part of [body,head,arm,offArm,weapon,...legs])batchPart(part);
  return {root,body,head,arm,offArm,legs,cloth,weapon,halo,glow,character,side,fabric,fabricRest,ornaments};
}

export function animateCloth(rig:FighterRig,time:number,power:number):void {
  const positions=rig.fabric.geometry.attributes['position'],rest=rig.fabricRest;
  for(let i=0;i<positions.count;i++) {
    const x=rest[i*3],y=rest[i*3+1],weight=(.775-y)/1.55;
    positions.setZ(i,rest[i*3+2]+Math.sin(time*3.3+weight*5+x*5)*weight*(.055+power*.12));
  }
  positions.needsUpdate=true;rig.fabric.geometry.computeVertexNormals();
  rig.ornaments.rotation.y=time*.5;
}
function batchPart(parent:T.Group):void {
  const batches=new Map<T.Material,T.Mesh[]>();
  for(const child of parent.children)if(child instanceof T.Mesh&&!Array.isArray(child.material)&&!child.children.length) {
    const list=batches.get(child.material)??[];list.push(child);batches.set(child.material,list);
  }
  for(const [material,meshes] of batches) {
    if(meshes.length<2)continue;
    const geometries=meshes.map(mesh=>{mesh.updateMatrix();const g=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();return g.applyMatrix4(mesh.matrix);});
    const merged=mergeGeometries(geometries,false);for(const g of geometries)g.dispose();if(!merged)continue;
    for(const mesh of meshes){parent.remove(mesh);mesh.geometry.dispose();}
    const result=new T.Mesh(merged,material);result.castShadow=true;result.receiveShadow=true;parent.add(result);
  }
}
