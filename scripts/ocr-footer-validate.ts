/* eslint-disable no-console */
/** Validate footer removal on ANY PDF (arg): (A) consistency single/partial/full on sample pages,
 *  (B) across all pages — footers removed vs options/content clipped (must be 0). */
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { cleanPageForDisplay } from '../src/shared/ocr-engine/crop-display-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
const cwb=(d:any):OcrWordBox[]=>{const o:OcrWordBox[]=[];for(const b of d?.blocks??[])for(const p of b.paragraphs??[])for(const l of p.lines??[])for(const w of l.words??[]){const t=(w.text??'').trim();if(!t||!w.bbox)continue;const{x0,y0,x1,y1}=w.bbox;if([x0,y0,x1,y1].some(v=>typeof v!=='number'))continue;o.push({text:t,x0,y0,x1,y1});}return o;};
const FOOT=/LEARNINGS|THESK|EDUCATIONAL|\+\d{2,}|\b\d{5,}\b|www\.|\.com/i;
const OPT=/\(?[a-dA-D]\)|\([1-9]\)|\d[).:]\s*\d/;
const seg=async(c:Buffer,wb:OcrWordBox[],i:number,flat:any,mask:any,dp:Buffer,off:number,st:Map<string,Buffer>)=>{const{drafts}=await segmentVisualDrafts(c,wb,i+1,{putObject:async(k:string,b:Buffer)=>{st.set(k,b);},figureKeyPrefix:'x',positionOffset:off,displayFlat:flat,displayMask:mask,displaySource:dp} as any);return drafts as OcrEngineDraft[];};
(async()=>{
  const file=process.argv[2]; const esm=new Function('s','return import(s)') as (s:string)=>Promise<any>;
  const {pdf}=await esm('pdf-to-img'); const doc=await pdf(fs.readFileSync(file),{scale:2});
  const pages:Buffer[]=[]; for await(const p of doc) pages.push(p as Buffer);
  const flat=await buildFlatField(pages); const mask=buildWatermarkMask(flat); const w=await createWorker('eng');
  const cleans:Buffer[]=[];const wbs:OcrWordBox[][]=[];
  for(let i=0;i<pages.length;i++){const c=await cleanPageImage(pages[i],flat);cleans.push(c);const{data}=await w.recognize(c,{},{blocks:true} as any);wbs.push(cwb(data));}
  // (A) consistency
  const bottomFoot=async(disp:Buffer)=>{const m=await sharp(disp).metadata();const H=m.height!,W=m.width!;const top=Math.round(H*0.75);const strip=await sharp(disp).extract({left:0,top,width:W,height:H-top}).toBuffer();const{data}=await w.recognize(strip);const t=(data.text??'').replace(/\s+/g,' ').trim();return FOOT.test(t)?t.slice(0,50):'';};
  console.log(`pages=${pages.length}`);
  for(const P of [1,Math.floor(pages.length/2),pages.length-1]){ if(P<0||P>=pages.length)continue;
    const s=await bottomFoot(await cleanPageForDisplay(pages[P],await buildFlatField([pages[P]]),null,wbs[P]));
    const pp=pages.slice(Math.max(0,P-1),P+2); const fp=await buildFlatField(pp);
    const pa=await bottomFoot(await cleanPageForDisplay(pages[P],fp,buildWatermarkMask(fp),wbs[P]));
    const fu=await bottomFoot(await cleanPageForDisplay(pages[P],flat,mask,wbs[P]));
    console.log(`  page ${P}: single=${s?'LEAK':'clean'} partial=${pa?'LEAK':'clean'} full=${fu?'LEAK':'clean'} consistent=${(!!s===!!pa)&&(!!pa===!!fu)}`);
  }
  // (B) footers removed vs options clipped (full-PDF context)
  const build=async(on:boolean)=>{ if(on)delete process.env.OCR_DISPLAY_FOOTER_TRIM; else process.env.OCR_DISPLAY_FOOTER_TRIM='false';
    const st=new Map<string,Buffer>(); let d:OcrEngineDraft[]=[]; for(let i=0;i<pages.length;i++){const dp=await cleanPageForDisplay(pages[i],flat,mask,wbs[i]); d=d.concat(await seg(cleans[i],wbs[i],i+1,flat,mask,dp,d.length,st));} return {st,d}; };
  const off=await build(false), on=await build(true);
  let footers=0,clipped=0; const ex:string[]=[];
  for(let k=0;k<off.d.length;k++){const ok=off.d[k].questionSnapshotKey,nk=on.d[k].questionSnapshotKey;if(!ok||!nk)continue;
    const om=await sharp(off.st.get(ok)!).metadata(),nm=await sharp(on.st.get(nk)!).metadata();
    if((nm.height??0)<(om.height??0)-4){const rem=await sharp(off.st.get(ok)!).extract({left:0,top:nm.height!,width:om.width!,height:om.height!-nm.height!}).toBuffer();const{data}=await w.recognize(rem);const t=(data.text??'').replace(/\s+/g,' ').trim();
      if(OPT.test(t)){clipped++; if(ex.length<6)ex.push(`Q${off.d[k].questionNumber}: "${t.slice(0,60)}"`);} else footers++; }}
  await w.terminate();
  console.log(`\n${path.basename(file)}: crops OFF=${off.d.length} ON=${on.d.length} (equal=${off.d.length===on.d.length})`);
  console.log(`footers-removed=${footers} | OPTION/CONTENT-CLIPPED=${clipped} (must be 0)`);
  if(ex.length) console.log(ex.map(e=>'  CLIP '+e).join('\n'));
})().catch(e=>{console.error(e);process.exit(1);});
