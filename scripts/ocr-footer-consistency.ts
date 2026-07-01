/* eslint-disable no-console */
/** Footer CONSISTENCY: the same page's footer must be removed identically whether the flat field is
 *  built from 1 page (single), 3 pages (partial), or the whole PDF (full). OCR the bottom of the
 *  display page in each context; footer text must be ABSENT in all three. */
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import * as fs from 'fs';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { cleanPageForDisplay } from '../src/shared/ocr-engine/crop-display-clean';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
const cwb=(d:any):OcrWordBox[]=>{const o:OcrWordBox[]=[];for(const b of d?.blocks??[])for(const p of b.paragraphs??[])for(const l of p.lines??[])for(const w of l.words??[]){const t=(w.text??'').trim();if(!t||!w.bbox)continue;const{x0,y0,x1,y1}=w.bbox;if([x0,y0,x1,y1].some(v=>typeof v!=='number'))continue;o.push({text:t,x0,y0,x1,y1});}return o;};
const FOOT=/LEARNINGS|THESK|EDUCATIONAL|\+\d{2,}|\b\d{5,}\b|www\.|\.com/i;
const run=async(file:string, P:number)=>{
  const esm=new Function('s','return import(s)') as (s:string)=>Promise<any>;
  const {pdf}=await esm('pdf-to-img'); const doc=await pdf(fs.readFileSync(file),{scale:2});
  const pages:Buffer[]=[]; for await(const p of doc) pages.push(p as Buffer);
  const w=await createWorker('eng');
  // OCR page P once (content identical across contexts; only the flat field differs)
  const cleanP=await cleanPageImage(pages[P], await buildFlatField(pages));
  const {data}=await w.recognize(cleanP,{},{blocks:true} as any); const wordsP=cwb(cleanP===pages[P]?data:data);
  const footerInBottom=async(disp:Buffer):Promise<string>=>{
    const m=await sharp(disp).metadata(); const H=m.height!,W=m.width!; const top=Math.round(H*0.75);
    const strip=await sharp(disp).extract({left:0,top,width:W,height:H-top}).toBuffer();
    const {data:od}=await w.recognize(strip); const t=(od.text??'').replace(/\s+/g,' ').trim();
    return FOOT.test(t)? t.slice(0,60):'';
  };
  const single=await cleanPageForDisplay(pages[P], await buildFlatField([pages[P]]), buildWatermarkMask(await buildFlatField([pages[P]])), wordsP);
  const partPages=pages.slice(Math.max(0,P-1),P+2); const fp=await buildFlatField(partPages);
  const partial=await cleanPageForDisplay(pages[P], fp, buildWatermarkMask(fp), wordsP);
  const ff=await buildFlatField(pages);
  const full=await cleanPageForDisplay(pages[P], ff, buildWatermarkMask(ff), wordsP);
  const [s,pa,fu]=[await footerInBottom(single),await footerInBottom(partial),await footerInBottom(full)];
  await w.terminate();
  console.log(`page ${P}: single=${s?('LEAK: "'+s+'"'):'clean'} | partial=${pa?('LEAK: "'+pa+'"'):'clean'} | full=${fu?('LEAK: "'+fu+'"'):'clean'} | consistent=${(!!s===!!pa)&&(!!pa===!!fu)}`);
};
(async()=>{ for(const P of [1,3,5]) await run('C:/Users/hp/Downloads/RE NEET PST 3 (1).pdf', P); })().catch(e=>{console.error(e);process.exit(1);});
