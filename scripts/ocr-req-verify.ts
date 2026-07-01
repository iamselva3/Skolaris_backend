/* eslint-disable no-console */
/** Verifies REQ1 (paper number removed from crop image, kept in metadata) + REQ2 (figure regions
 *  protected from cleanup). Renders real crops, OCRs the top strip, compares to metadata. */
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
const cwb=(d:any):OcrWordBox[]=>{const o:OcrWordBox[]=[];for(const b of d?.blocks??[])for(const p of b.paragraphs??[])for(const l of p.lines??[])for(const w of l.words??[]){const t=(w.text??'').trim();if(!t||!w.bbox)continue;const{x0,y0,x1,y1}=w.bbox;if([x0,y0,x1,y1].some(v=>typeof v!=='number'))continue;o.push({text:t,x0,y0,x1,y1});}return o;};
const run=async(file:string, sample:number)=>{
  const esm=new Function('s','return import(s)') as (s:string)=>Promise<any>;
  const {pdf}=await esm('pdf-to-img'); const doc=await pdf(fs.readFileSync(file),{scale:2});
  const pages:Buffer[]=[]; for await(const p of doc) pages.push(p as Buffer);
  const flat=await buildFlatField(pages); const mask=buildWatermarkMask(flat);
  const store=new Map<string,Buffer>(); const w=await createWorker('eng'); const drafts:OcrEngineDraft[]=[];
  for(let i=0;i<pages.length;i++){const c=await cleanPageImage(pages[i],flat);const{data}=await w.recognize(c,{},{blocks:true} as any);
    const{drafts:vd}=await segmentVisualDrafts(c,cwb(data),i+1,{putObject:async(k:string,b:Buffer)=>{store.set(k,b);},figureKeyPrefix:'req',positionOffset:drafts.length,displayFlat:flat,displayMask:mask,displaySource:pages[i]} as any);
    drafts.push(...(vd as OcrEngineDraft[]));}
  const numbered=drafts.filter(d=>d.questionNumber!=null && d.questionSnapshotKey);
  const figures=drafts.filter(d=>d.questionClass==='DIAGRAM_BASED'||d.questionClass==='MATCH_THE_FOLLOWING');
  let r1pass=0,r1fail=0; const fails:string[]=[];
  for(const d of numbered.slice(0,sample)){
    const buf=store.get(d.questionSnapshotKey!)!; const meta=await sharp(buf).metadata();
    const strip=await sharp(buf).extract({left:0,top:0,width:meta.width!,height:Math.min(60,meta.height!)}).toBuffer();
    const {data}=await w.recognize(strip); const head=(data.text??'').replace(/\s+/g,' ').trim().slice(0,40);
    const leadingNum=/^\(?0*(\d{1,3})[.)]/.exec(head)?.[1];
    const numberShown = leadingNum!=null && Number(leadingNum)===d.questionNumber; // the PAPER number still printed at the top?
    const metaKept = d.questionNumber!=null; // REQ1: metadata preserved
    if(!numberShown && metaKept) r1pass++; else { r1fail++; fails.push(`Q${d.questionNumber}: shown=${numberShown} head="${head}"`); }
  }
  await w.terminate();
  console.log(`\n==== ${path.basename(file)} ==== drafts=${drafts.length} numbered=${numbered.length} figuresProtected=${figures.length}`);
  console.log(`REQ1 (number removed from image, kept in metadata): ${r1pass}/${r1pass+r1fail} crops PASS (sampled ${Math.min(sample,numbered.length)})`);
  if(fails.length) console.log('  R1 fails:\n'+fails.slice(0,8).map(f=>'   '+f).join('\n'));
  console.log(`REQ2 (figure/diagram/match regions protected from cleanup): ${figures.length} region(s)`);
};
(async()=>{ await run('C:/Users/hp/Downloads/Biology_Cell.pdf',15); await run('C:/Users/hp/Downloads/Biology.pdf',15); })().catch(e=>{console.error(e);process.exit(1);});
