import sharp from 'sharp';
export type ProcessedImage={width:number;height:number;bytes:Buffer;thumbnail:Buffer};
export type ImageProcessor=(original:Buffer,signal?:AbortSignal)=>Promise<ProcessedImage>;
export const processImage:ImageProcessor=async(original,signal)=>{
 signal?.throwIfAborted();if(original.length>16*1024*1024)throw Error('图片过大');
 const info=await sharp(original,{limitInputPixels:40000000}).metadata();
 if(!['jpeg','png','webp','avif','heif'].includes(info.format || ''))throw Error('图片格式无法安全预览');
 const bytes=await sharp(original,{limitInputPixels:40000000}).rotate().webp({quality:90}).toBuffer();
 const thumbnail=await sharp(bytes).resize({width:720,height:720,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer();
 signal?.throwIfAborted();if(bytes.length>16*1024*1024)throw Error('图片处理结果过大');
 return {width:info.autoOrient.width,height:info.autoOrient.height,bytes,thumbnail};
};
