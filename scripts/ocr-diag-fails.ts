/* eslint-disable no-console */
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
const cwb = (d:any):OcrWordBox[]=>{const o:OcrWordBox[]=[];for(const b of d?.blocks??[])for(const p of b.paragraphs??[])for(const l of p.lines??[])for(const w of l.words??[]){const t=(w.text??'').trim();if(!t||!w.bbox)continue;const{x0,y0,x1,y1}=w.bbox;if([x0,y0,x1,y1].some(v=>typeof v!=='number'))continue;o.push({text:t,x0,y0,x1,y1});}return o;};
(async()=>{
  const esm=new Function('s','return import(s)') as (s:string)=>Promise<any>;
  const {pdf}=await esm('pdf-to-img'); const doc=await pdf(fs.readFileSync('C:/Users/hp/Downloads/Biology_Cell.pdf'),{scale:2});
  const pages:Buffer[]=[]; for await(const p of doc) pages.push(p as Buffer);
  const flat=await buildFlatField(pages); const mask=buildWatermarkMask(flat);
  const w=await createWorker('eng'); const base:OcrEngineDraft[]=[];
  for(let i=0;i<pages.length;i++){const c=await cleanPageImage(pages[i],flat);const{data}=await w.recognize(c,{},{blocks:true} as any);
    const{drafts:vd}=await segmentVisualDrafts(c,cwb(data),i+1,{putObject:async()=>{},figureKeyPrefix:'x',positionOffset:base.length,displayFlat:flat,displayMask:mask,displaySource:pages[i]} as any);
    base.push(...(vd as OcrEngineDraft[]));}
  await w.terminate();
  for(const n of [5,3,38,43,47]){
    const ds=base.filter(d=>d.questionNumber===n);
    console.log(`\n=== Q${n}: ${ds.length} base draft(s) ===`);
    for(const d of ds){const c=d.sourceCoordinates;console.log(`  p${d.sourcePageNumber} bbox=[${c?.x0},${c?.y0},${c?.x1},${c?.y1}] opts=${d.optionCount} text="${(d.text??'').replace(/\s+/g,' ').slice(0,90)}"`);}
  }
})().catch(e=>{console.error(e);process.exit(1);});
