import {execFileSync} from 'node:child_process';
import {mkdirSync,existsSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const run=(command,args)=>execFileSync(command,args,{stdio:'inherit'});
function checkout(name,url,revision){
  const path=join('native/.deps',name);
  if(!existsSync(join(path,'.git'))){
    mkdirSync(path,{recursive:true});run('git',['init',path]);run('git',['-C',path,'remote','add','origin',url]);
    run('git',['-C',path,'fetch','--depth','1','origin',revision]);run('git',['-C',path,'checkout','--detach','FETCH_HEAD']);
  }
  const actual=execFileSync('git',['-C',path,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(actual!==revision)throw new Error(`Unexpected ${name} dependency version in ${path}. Expected ${revision}.`);
  return path;
}
if(process.platform==='darwin'){
  mkdirSync('native/bin',{recursive:true});
  execFileSync('swiftc',['-O','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos14.2`,'native/audio-activity.swift','-framework','CoreAudio','-o','native/bin/quicken-audio-activity'],{stdio:'inherit'});
  if(process.arch==='arm64'){
    run('swiftc',['-parse-as-library','-O','-target','arm64-apple-macos14.2','native/local-voice.swift','-framework','AVFoundation','-o','native/bin/quicken-voice']);
    const fluid=checkout('FluidAudio','https://github.com/FluidInference/FluidAudio.git','e396cf780c4abf8e395087467c0585d3b0d17f68');
    // Compile ASR only. Exclude unrelated speech/diarization and their binary dependencies.
    const manifest=readFileSync('native/fluid-asr-package.swift');
    for(const name of ['Package.swift','Package@swift-6.2.swift'])writeFileSync(join(fluid,name),manifest);
    run('swift',['build','--package-path','native/LocalSpeech','-c','release']);
    copyFileSync('native/LocalSpeech/.build/release/quicken-speech','native/bin/quicken-speech');
    const llama=checkout('llama.cpp','https://github.com/ggml-org/llama.cpp.git','8642541b255bfb5dc39cd351a178be09013a55d6');
    if(!existsSync(join(llama,'build/bin/llama-server'))){
      run('cmake',['-S',llama,'-B',join(llama,'build'),'-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=OFF','-DGGML_METAL_EMBED_LIBRARY=ON','-DLLAMA_BUILD_TESTS=OFF','-DLLAMA_BUILD_EXAMPLES=OFF','-DLLAMA_BUILD_SERVER=ON','-DLLAMA_OPENSSL=OFF','-DGGML_NATIVE=OFF','-DCMAKE_OSX_DEPLOYMENT_TARGET=14.2']);
      run('cmake',['--build',join(llama,'build'),'--config','Release','-j','6','--target','llama-server']);
    }
    copyFileSync(join(llama,'build/bin/llama-server'),'native/bin/quicken-llm');
  }
}
