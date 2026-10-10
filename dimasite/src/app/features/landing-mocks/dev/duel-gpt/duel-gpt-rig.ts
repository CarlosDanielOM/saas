import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DuelCharacter, DuelSide } from '../../../widgets/duel/duel-battle';

/** Original procedural models. All joints and GPU resources are created once. */
export interface FighterRig {
  root: T.Group; body: T.Group; head: T.Group; arm: T.Group; offArm: T.Group;
  legs: T.Group[]; cloth: T.Group; weapon: T.Group; halo: T.Mesh;
  glow: T.MeshStandardMaterial; character: DuelCharacter; side: DuelSide;
}

export function fighterRig(character: DuelCharacter, side: DuelSide, enraged: boolean): FighterRig {
  const root = new T.Group(), body = new T.Group(), head = new T.Group();
  const arm = new T.Group(), offArm = new T.Group(), cloth = new T.Group(), weapon = new T.Group();
  const tint = enraged ? '#ff354f' : side === 'left' ? '#a892ff' : '#ffd08b';
  const steel = new T.MeshStandardMaterial({color: '#9ba8c2', metalness: .75, roughness: .32});
  const dark = new T.MeshStandardMaterial({color: '#171e31', metalness: .65, roughness: .42});
  const gold = new T.MeshStandardMaterial({color: '#cfaa67', metalness: .75, roughness: .3});
  const fabric = new T.MeshStandardMaterial({color: side === 'left' ? '#49367d' : '#794b2c', roughness: .9, side: T.DoubleSide});
  const glow = new T.MeshStandardMaterial({color: tint, emissive: tint, emissiveIntensity: 2.4, metalness: .35, roughness: .3});
  const skin = new T.MeshStandardMaterial({color: '#cba98e', roughness: .8});
  const mesh = (parent: T.Object3D, geometry: T.BufferGeometry, material: T.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): T.Mesh => {
    const m = new T.Mesh(geometry, material); m.position.set(x,y,z); m.scale.set(sx,sy,sz);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const box = (parent: T.Object3D, mat: T.Material, x: number, y: number, z: number, w: number, h: number, d: number) => mesh(parent,new T.BoxGeometry(w,h,d),mat,x,y,z);
  const sphere = (parent: T.Object3D, mat: T.Material, x: number, y: number, z: number, radius: number, sx=1,sy=1,sz=1) => mesh(parent,new T.SphereGeometry(radius,16,12),mat,x,y,z,sx,sy,sz);
  root.add(body); body.position.y = 1.15;
  body.add(head,arm,offArm,cloth); head.position.y = 1.08;
  arm.position.set(.46,.66,0); offArm.position.set(-.46,.66,0);
  arm.add(weapon); weapon.position.set(0,-.67,.12);
  const legs: T.Group[] = [];
  for (const x of [-.24,.24]) {
    const leg = new T.Group(); leg.position.set(x,.02,0); body.add(leg); legs.push(leg);
    mesh(leg,new T.CapsuleGeometry(.14,.43,4,8),dark,0,-.32,0);
    sphere(leg,gold,0,-.49,.04,.155,1,.7,1);
    box(leg,character==='knight'?steel:dark,0,-.76,0,.27,.45,.28);
    box(leg,dark,0,-1,.1,.32,.16,.48);
  }
  for (const limb of [arm,offArm]) {
    sphere(limb,character==='knight'?steel:fabric,0,0,0,.22,1.2,.9,1);
    mesh(limb,new T.CapsuleGeometry(.12,.36,4,8),character==='knight'?steel:fabric,0,-.31,0);
    sphere(limb,gold,0,-.47,.035,.13);
    box(limb,dark,0,-.58,.02,.2,.24,.23);
    sphere(limb,character==='mage'?skin:dark,0,-.73,.07,.125);
  }
  // Segmented fabric strips retain a readable silhouette at overlay sizes.
  for (let i=0;i<7;i++) {
    const strip = box(cloth,fabric,(i-3)*.12,-.12,-.27,.15,1.36,.07);
    strip.rotation.x = -.17; strip.rotation.z = (i-3)*-.06;
    box(strip,gold,0,-.62,.045,.09,.05,.04);
  }
  const halo = mesh(root,new T.TorusGeometry(.65,.024,6,48),glow,0,.055,0);
  halo.rotation.x=-Math.PI/2; halo.scale.set(1.6,1.6,1.6);
  if (character==='knight') {
    mesh(body,new T.CylinderGeometry(.43,.34,.83,8),steel,0,.42,0,1,1,.8);
    box(body,dark,0,.42,.32,.48,.57,.09);
    box(body,gold,0,.4,.38,.055,.43,.045); box(body,gold,0,.48,.38,.27,.05,.045);
    box(body,gold,0,.025,.02,.79,.15,.57);
    sphere(head,steel,0,0,0,.35,1,1.12,.9);
    box(head,dark,0,-.01,.28,.57,.16,.09);
    box(head,glow,-.14,0,.345,.15,.035,.025); box(head,glow,.14,0,.345,.15,.035,.025);
    box(head,gold,0,.17,.32,.04,.43,.03);
    for(let i=0;i<5;i++) {
      const plume=mesh(head,new T.ConeGeometry(.09,.42,4),fabric,0,.37+i*.025,-.16+i*.065);
      plume.rotation.x=-.7;
    }
    for(const limb of [arm,offArm]) {
      box(limb,gold,0,.07,.02,.47,.09,.42);
      mesh(limb,new T.ConeGeometry(.09,.22,4),steel,0,.18,0);
    }
    box(weapon,gold,0,.1,0,.58,.09,.14);
    box(weapon,dark,0,-.1,0,.1,.3,.1);
    const blade = mesh(weapon,new T.CylinderGeometry(.005,.09,1.45,4),steel,0,.86,0,1,1,.3);
    blade.rotation.y=Math.PI/4;
    box(weapon,glow,0,.78,.037,.022,1.05,.012);
    const shield=mesh(offArm,new T.CylinderGeometry(.37,.32,.12,6),dark,-.13,-.48,.23,1,1,1.35);
    shield.rotation.x=Math.PI/2;
    const rim=mesh(offArm,new T.TorusGeometry(.32,.027,4,6),gold,-.13,-.48,.305,1,1.35,1);
    rim.rotation.z=Math.PI/6;
    box(offArm,glow,-.13,-.48,.32,.045,.41,.02);box(offArm,glow,-.13,-.46,.32,.28,.045,.02);
  } else if(character==='ronin') {
    mesh(body,new T.CylinderGeometry(.36,.41,.83,8),fabric,0,.4,0,1,1,.85);
    for(let i=0;i<5;i++) box(body,dark,0,.12+i*.13,.29,.7-i*.05,.095,.13);
    for(let i=0;i<3;i++)box(body,gold,-.21+i*.21,.44,.37,.022,.48,.025);
    box(body,gold,0,.015,0,.85,.11,.58);
    sphere(head,skin,0,-.035,.025,.29,1,1.1,.85);
    box(head,dark,0,-.13,.22,.45,.18,.1);
    box(head,glow,-.115,.015,.27,.12,.023,.02);box(head,glow,.115,.015,.27,.12,.023,.02);
    mesh(head,new T.ConeGeometry(.66,.24,32),gold,0,.29,0);
    mesh(head,new T.TorusGeometry(.52,.015,4,32),dark,0,.19,0).rotation.x=Math.PI/2;
    for(let i=0;i<12;i++) {
      const spoke=box(head,dark,0,.23,0,.014,.01,.65);
      spoke.rotation.y=i*Math.PI/6;
    }
    const sash=box(cloth,glow,-.35,.66,-.34,.13,.62,.025);sash.rotation.z=-.4;
    box(weapon,dark,0,-.12,0,.09,.36,.09);
    mesh(weapon,new T.TorusGeometry(.1,.025,5,16),gold,0,.08,0).rotation.x=Math.PI/2;
    const blade=box(weapon,steel,.055,.88,0,.075,1.6,.025);blade.rotation.z=-.07;
    box(weapon,glow,.086,.89,.019,.016,1.53,.008).rotation.z=-.07;
    box(body,dark,-.4,.06,-.33,.09,1.4,.12).rotation.z=-1;
  } else {
    mesh(body,new T.CylinderGeometry(.34,.61,1.38,10),fabric,0,.11,0,1,1,.8);
    for(let i=0;i<6;i++) {
      const seam=box(body,gold,0,-.1,.44,.025,1.19,.025);seam.rotation.y=i*Math.PI/3;
    }
    sphere(head,dark,0,-.015,.04,.31,1,1.1,.85);
    box(head,glow,-.105,.01,.275,.12,.035,.02);box(head,glow,.105,.01,.275,.12,.035,.02);
    mesh(head,new T.ConeGeometry(.43,.78,8),fabric,-.055,.45,0).rotation.z=.18;
    mesh(head,new T.CylinderGeometry(.53,.53,.055,12),dark,0,.14,0);
    mesh(head,new T.TorusGeometry(.32,.02,5,24),gold,0,.24,0).rotation.x=Math.PI/2;
    box(body,gold,0,.035,.015,.84,.1,.6);
    const gem=mesh(body,new T.OctahedronGeometry(.14),glow,0,.53,.31);gem.scale.y=1.5;
    mesh(weapon,new T.CylinderGeometry(.038,.045,2.55,8),gold,0,.49,0);
    mesh(weapon,new T.TorusGeometry(.22,.035,6,20),gold,0,1.78,0);
    mesh(weapon,new T.OctahedronGeometry(.19),glow,0,1.78,0);
    for(let i=0;i<3;i++)mesh(weapon,new T.TorusGeometry(.1,.015,4,16),dark,0,1.16+i*.14,0).rotation.x=Math.PI/2;
  }
  // Collapse the decorative pieces of each articulated part into material batches.
  // Joints remain separate; silhouettes and animation are unchanged.
  for(const part of [body,head,arm,offArm,cloth,weapon,...legs])batchPart(part);
  return {root,body,head,arm,offArm,legs,cloth,weapon,halo,glow,character,side};
}

function batchPart(parent:T.Group):void {
  const batches=new Map<T.Material,T.Mesh[]>();
  for(const child of parent.children)if(child instanceof T.Mesh&&!Array.isArray(child.material)) {
    const list=batches.get(child.material)??[];list.push(child);batches.set(child.material,list);
  }
  for(const [material,meshes] of batches) {
    if(meshes.length<2)continue;
    const geometries=meshes.map(mesh=>{mesh.updateMatrix();return mesh.geometry.clone().applyMatrix4(mesh.matrix);});
    const merged=mergeGeometries(geometries,false);
    for(const geometry of geometries)geometry.dispose();
    if(!merged)continue;
    for(const mesh of meshes){parent.remove(mesh);mesh.geometry.dispose();}
    const mesh=new T.Mesh(merged,material);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);
  }
}
