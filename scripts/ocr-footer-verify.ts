/* eslint-disable no-console */
/** Footer-removal verification. For each paper: segment crops with footer-trim OFF then ON, OCR the
 *  BOTTOM strip of each crop, count crops whose bottom contains footer chrome (phone/website).
 *  Expect: ON << OFF (footers removed), and equal crop counts (no content removed). */
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { cleanPageForDisplay } from '../src/shared/ocr-engine/crop-display-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
const PHONE=/\+\d{2,}|\b\d{5,}\b/; const WEB=/(www\.|https?:|\.com|\.in\b|\.org|\.edu|\.net)/i;
const cwb=(d:any):OcrWordBox[]=>{const o:OcrWordBox[]=[];for(const b of d?.blocks??[])for(const p of b.paragraphs??[])for(const l of p.lines??[])for(const w of l.words??[]){const t=(w.text??'').trim();if(!t||!w.bbox)continue;const{x0,y0,x1,y1}=w.bbox;if([x0,y0,x1,y1].some(v=>typeof v!=='number'))continue;o.push({text:t,x0,y0,x1,y1});}return o;};
const segment=async(clean:Buffer,wb:OcrWordBox[],i:number,flat:any,mask:any,displayPage:Buffer,off:number,store:Map<string,Buffer>)=>{
  const {drafts}=await segmentVisualDrafts(clean,wb,i+1,{putObject:async(k:string,b:Buffer)=>{store.set(k,b);},figureKeyPrefix:'ft',positionOffset:off,displayFlat:flat,displayMask:mask,displaySource:displayPage} as any);
  return drafts as OcrEngineDraft[];
};
const footerHits=async(drafts:OcrEngineDraft[],store:Map<string,Buffer>,w:any):Promise<number>=>{
  let hits=0;
  for(const d of drafts){ if(!d.questionSnapshotKey) continue; const buf=store.get(d.questionSnapshotKey); if(!buf) continue;
    const m=await sharp(buf).metadata(); const H=m.height!,W=m.width!; const top=Math.round(H*0.6);
    const strip=await sharp(buf).extract({left:0,top:top,width:W,height:H-top}).toBuffer();
    const {data}=await w.recognize(strip); const t=(data.text??'').replace(/\s+/g,' ');
    if(PHONE.test(t)||WEB.test(t)) hits++;
  }
  return hits;
};
const run=async(file:string)=>{
  const esm=new Function('s','return import(s)') as (s:string)=>Promise<any>;
  const {pdf}=await esm('pdf-to-img'); const doc=await pdf(fs.readFileSync(file),{scale:2});
  const pages:Buffer[]=[]; for await(const p of doc) pages.push(p as Buffer);
  const flat=await buildFlatField(pages); const mask=buildWatermarkMask(flat);
  const w=await createWorker('eng');
  const cleans:Buffer[]=[]; const wbs:OcrWordBox[][]=[]; const disp:Buffer[]=[];
  for(let i=0;i<pages.length;i++){const c=await cleanPageImage(pages[i],flat);cleans.push(c);const{data}=await w.recognize(c,{},{blocks:true} as any);const wb=cwb(data);wbs.push(wb);disp.push(await cleanPageForDisplay(pages[i],flat,mask,wb));}
  // OFF
  process.env.OCR_DISPLAY_FOOTER_TRIM='false'; const offStore=new Map<string,Buffer>(); let offD:OcrEngineDraft[]=[];
  for(let i=0;i<pages.length;i++) offD=offD.concat(await segment(cleans[i],wbs[i],i+1,flat,mask,disp[i],offD.length,offStore));
  const offHits=await footerHits(offD,offStore,w);
  // ON
  delete process.env.OCR_DISPLAY_FOOTER_TRIM; const onStore=new Map<string,Buffer>(); let onD:OcrEngineDraft[]=[];
  for(let i=0;i<pages.length;i++) onD=onD.concat(await segment(cleans[i],wbs[i],i+1,flat,mask,disp[i],onD.length,onStore));
  const onHits=await footerHits(onD,onStore,w);
  await w.terminate();
  console.log(`${path.basename(file)} | crops OFF=${offD.length} ON=${onD.length} (equal=${offD.length===onD.length}) | footer-chrome-at-bottom OFF=${offHits} ON=${onHits}`);
};
(async()=>{ for(const f of process.argv.slice(2)) { try{await run(f);}catch(e){console.log(`${path.basename(f)} ERROR ${e instanceof Error?e.message:e}`);} } })().catch(e=>{console.error(e);process.exit(1);});
