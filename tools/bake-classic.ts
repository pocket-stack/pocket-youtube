/** Offline 4x rasterization. Device UI draws these at their authored size. */
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
const root = new URL("../", import.meta.url).pathname;
const pow2 = (v: number) => 2 ** Math.ceil(Math.log2(v));
const sizes: Record<string, { width: number; height: number; textureWidth: number; textureHeight: number }> = {};
function bake(name: string, w: number, h: number, paint: (g: SKRSContext2D) => void) {
  const hi = createCanvas(w * 4, h * 4), g = hi.getContext("2d"); g.scale(4, 4); paint(g);
  const out = createCanvas(pow2(w), pow2(h)), ctx = out.getContext("2d");
  ctx.drawImage(hi, 0, 0, w, h);
  writeFileSync(root + "app/" + name + ".png", out.toBuffer("image/png"));
  sizes[name] = { width: w, height: h, textureWidth: pow2(w), textureHeight: pow2(h) };
}
function gradient(g: SKRSContext2D, h: number, stops: [number, string][]) {
  const v = g.createLinearGradient(0, 0, 0, h); for (const [at, color] of stops) v.addColorStop(at, color); return v;
}
function round(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) { g.beginPath(); g.roundRect(x, y, w, h, r); }

bake("classic-search-card",296,108,g=>{
  round(g,.5,2.5,295,105,7);g.fillStyle="#b7bfcb";g.fill();
  round(g,.5,.5,295,105,7);g.fillStyle=gradient(g,106,[[0,"#ffffff"],[.65,"#f8f9fb"],[1,"#e6ebf2"]]);g.fill();
  g.strokeStyle="#a4afbf";g.lineWidth=1;g.stroke();
  round(g,1.5,1.5,293,103,6);g.strokeStyle="#ffffff";g.stroke();
  g.fillStyle="#d4dae3";g.fillRect(1,69,294,1);g.fillStyle="#ffffff";g.fillRect(1,70,294,1);
});
// Each cap has its optical width before power-of-two padding. Tile must use
// the matching cap: clipping a 68 px cap into a narrower hit target loses its edge.
const buttons: [string, number, number, boolean][] = [
  ["classic-button",72,56,false], ["classic-play-button",144,56,true], ["classic-wide-button",304,28,false],
  ...[56, 68, 70, 76, 152].map(w => [`classic-small-${w}`, w, 26, false] as [string, number, number, boolean]),
];
for(const [name,w,h,blue] of buttons) {
  bake(name,w,h,g=>{
    round(g,.5,1.5,w-1,h-2,6);g.fillStyle="#8f99a8";g.fill();
    round(g,.5,.5,w-1,h-3,6);g.fillStyle=gradient(g,h,blue?[[0,"#8bb7ed"],[.49,"#438add"],[.5,"#2d73c8"],[1,"#205ba6"]]:[[0,"#ffffff"],[.49,"#e9ecf1"],[.5,"#d6dce5"],[1,"#bdc6d2"]]);g.fill();
    g.strokeStyle=blue?"#205999":"#8793a3";g.lineWidth=1;g.stroke();
    round(g,1.5,1.5,w-3,h-5,5);g.strokeStyle=blue?"rgba(255,255,255,.45)":"rgba(255,255,255,.85)";g.stroke();
  });
}
for(const name of ["play","pause","back","next","search","chevron","speaker"]){
  bake("classic-"+name,32,32,g=>{
    g.fillStyle=name==="play"||name==="pause"?"#ffffff":"#52647b";
    g.strokeStyle="#52647b";g.lineWidth=2.5;g.lineCap="round";g.lineJoin="round";
    if(name==="play"){g.beginPath();g.moveTo(10,5);g.lineTo(26,16);g.lineTo(10,27);g.closePath();g.fill();}
    if(name==="pause"){g.fillRect(8,6,6,20);g.fillRect(19,6,6,20);}
    if(name==="back"||name==="next"){
      if(name==="next"){g.translate(32,0);g.scale(-1,1);}
      for(const x of [5,16]){g.beginPath();g.moveTo(x,16);g.lineTo(x+11,7);g.lineTo(x+11,25);g.closePath();g.fill();}
    }
    if(name==="search"){g.beginPath();g.arc(13,13,7,0,Math.PI*2);g.stroke();g.beginPath();g.moveTo(18,18);g.lineTo(26,26);g.stroke();}
    if(name==="chevron"){g.beginPath();g.moveTo(12,8);g.lineTo(20,16);g.lineTo(12,24);g.stroke();}
    if(name==="speaker"){g.beginPath();g.moveTo(5,12);g.lineTo(11,12);g.lineTo(19,6);g.lineTo(19,26);g.lineTo(11,20);g.lineTo(5,20);g.closePath();g.fill();g.beginPath();g.arc(17,16,10,-.8,.8);g.stroke();}
  });
}
const logo = await loadImage(root+"artwork/youtube/logo-white.svg");
const source=createCanvas(logo.width,logo.height), sg=source.getContext("2d");sg.drawImage(logo,0,0);
const px=sg.getImageData(0,0,logo.width,logo.height).data;
let left=logo.width,right=0,top=logo.height,bottom=0;
for(let y=0;y<logo.height;y++)for(let x=0;x<logo.width;x++)if(px[(y*logo.width+x)*4+3]>0){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
const w=right-left+1,h=bottom-top+1,logoW=220,logoH=Math.round(logoW*h/w);
bake("yt-logo-white",logoW,logoH,g=>g.drawImage(source,left,top,w,h,0,0,logoW,logoH));
const icon=await loadImage(root+"artwork/youtube/icon.svg");
bake("yt-icon",64,64,g=>g.drawImage(icon,0,(64-64*26/37)/2,64,64*26/37));
writeFileSync(root+"artwork/bake-receipt.json",JSON.stringify(sizes,null,2)+"\n");
console.log(`Baked ${Object.keys(sizes).length} assets; official logo ${logoW}x${logoH}, source ratio ${w}/${h}`);
