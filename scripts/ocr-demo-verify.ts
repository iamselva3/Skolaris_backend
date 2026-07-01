/* eslint-disable no-console */
/** DEMO verification — FINAL CLIENT OUTPUT only. REQ1: number gone from EVERY crop + metadata kept.
 *  REQ2: background lifted (lighter) + figures protected. Runs the real delivery path. */
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
const run=async(file:string)=>{
  const esm=new Function('s','return import(s)') as (s:string)=>Promise<any>;
  const {pdf}=await esm('pdf-to-img'); const doc=await pdf(fs.readFileSync(file),{scale:2});
  const pages:Buffer[]=[]; for await(const p of doc) pages.push(p as Buffer);
  const flat=await buildFlatField(pages); const mask=buildWatermarkMask(flat);
  const store=new Map<string,Buffer>(); const rawStore=new Map<string,Buffer>(); const w=await createWorker('eng'); const drafts:OcrEngineDraft[]=[];
  for(let i=0;i<pages.length;i++){const c=await cleanPageImage(pages[i],flat);const{data}=await w.recognize(c,{},{blocks:true} as any);
    const displayPage=await cleanPageForDisplay(pages[i],flat,mask); // production displaySource (page-level bg removal)
    const{drafts:vd}=await segmentVisualDrafts(c,cwb(data),i+1,{putObject:async(k:string,b:Buffer)=>{store.set(k,b);},figureKeyPrefix:'demo',positionOffset:drafts.length,displayFlat:flat,displayMask:mask,displaySource:displayPage} as any);
    drafts.push(...(vd as OcrEngineDraft[]));}
  const numbered=drafts.filter(d=>d.questionNumber!=null && d.questionSnapshotKey);
  const figures=drafts.filter(d=>d.questionClass==='DIAGRAM_BASED'||d.questionClass==='MATCH_THE_FOLLOWING');
  let numberShown=0, metaKept=0, bgLifted=0; const shownList:string[]=[];
  for(const d of drafts){
    if(!d.questionSnapshotKey) continue;
    const buf=store.get(d.questionSnapshotKey)!; const meta=await sharp(buf).metadata();
    if(d.questionNumber!=null) metaKept++;
    // REQ1: OCR top strip, check no leading number marker
    const strip=await sharp(buf).extract({left:0,top:0,width:meta.width!,height:Math.min(70,meta.height!)}).toBuffer();
    const {data:od}=await w.recognize(strip); const head=(od.text??'').replace(/\s+/g,' ').trim();
    if(/^\(?\d{1,3}[.)]/.test(head)){ numberShown++; if(shownList.length<10) shownList.push(`Q${d.questionNumber}: "${head.slice(0,30)}"`); }
    // REQ2: mean luminance high (background lifted toward white)
    const stats=await sharp(buf).stats(); const meanLum=stats.channels.slice(0,3).reduce((s,c)=>s+c.mean,0)/Math.min(3,stats.channels.length);
    if(meanLum>=235) bgLifted++;
  }
  await w.terminate();
  console.log(`\n==== ${path.basename(file)} ==== crops=${drafts.length} numbered=${numbered.length} figuresProtected=${figures.length}`);
  console.log(`REQ1  number VISIBLE on crop: ${numberShown}/${drafts.length}  (target 0)  | metadata kept: ${metaKept}/${numbered.length}`);
  if(shownList.length) console.log('  still-shown:\n'+shownList.map(s=>'   '+s).join('\n'));
  console.log(`REQ2  crops with lifted (mean≥235) background: ${bgLifted}/${drafts.length} | figures protected: ${figures.length}`);
};
(async()=>{ for(const f of ['C:/Users/hp/Downloads/Biology_Cell.pdf','C:/Users/hp/Downloads/Biology.pdf','C:/Users/hp/Downloads/AD 2601 Q.pdf']) await run(f); })().catch(e=>{console.error(e);process.exit(1);});
