// Canonical mono, 16 kHz, 16-bit PCM keeps browser recordings portable.
export const voiceSampleRate=16000;
export const voiceMaxSeconds=120;
export const voiceMaxBytes=44+voiceSampleRate*2*voiceMaxSeconds;
export function encodeVoiceWav(samples){
  if(!samples.length||samples.length>voiceSampleRate*voiceMaxSeconds)throw new Error('录音长度无效，请分段录制');
  const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer);
  const text=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
  text(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,voiceSampleRate,true);view.setUint32(28,voiceSampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++){const value=Math.max(-1,Math.min(1,Number.isFinite(samples[i])?samples[i]:0));view.setInt16(44+i*2,Math.round(value*(value<0?32768:32767)),true);}
  return new Uint8Array(buffer);
}
export function inspectVoiceWav(bytes){
  const bad=()=>{throw Object.assign(new Error('录音格式或长度无效，请重新录制（最多两分钟）'),{status:400});};
  if(bytes.byteLength<44+voiceSampleRate||bytes.byteLength>voiceMaxBytes)return bad();
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),text=(offset,length)=>String.fromCharCode(...bytes.subarray(offset,offset+length));
  if(text(0,4)!=='RIFF'||text(8,8)!=='WAVEfmt '||text(36,4)!=='data'||v.getUint32(4,true)!==bytes.byteLength-8||v.getUint32(16,true)!==16||v.getUint16(20,true)!==1||v.getUint16(22,true)!==1||v.getUint32(24,true)!==voiceSampleRate||v.getUint32(28,true)!==voiceSampleRate*2||v.getUint16(32,true)!==2||v.getUint16(34,true)!==16||v.getUint32(40,true)!==bytes.byteLength-44||(bytes.byteLength-44)%2)return bad();
  let peak=0;for(let i=44;i<bytes.byteLength;i+=2)peak=Math.max(peak,Math.abs(v.getInt16(i,true)));
  if(peak<8)throw Object.assign(new Error('没有录到声音，请检查麦克风后重试'),{status:400});
  return {seconds:(bytes.byteLength-44)/(voiceSampleRate*2)};
}
