#!/usr/bin/env python3
"""Regenerate only the sample project, with exact source identity. No FEX build.

Re-select the existing signing team/identifier in Xcode after generation. This
script does not discover, store, sign with or publish signing credentials.
"""
import json, pathlib, re, subprocess, tempfile
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[1]
def main():
    if (ROOT/'.git').exists():
        revision=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
        tracked=subprocess.check_output(['git','-C',str(ROOT),'status','--porcelain','--untracked-files=no'],text=True).strip()
        state='tracked-edits-present' if tracked else 'tracked-files-clean'
    elif (ROOT/'SOURCE-MANIFEST.json').is_file():
        manifest=json.loads((ROOT/'SOURCE-MANIFEST.json').read_text())
        revision=manifest.get('sourceRevision','')
        if not isinstance(revision,str) or not re.fullmatch('[0-9a-f]{40}',revision):
            raise ValueError('Invalid exported source revision.')
        state='source-export; local edits not verified'
    else:
        revision='unrecorded';state='no source identity available'
    # Keep the temporary spec alongside project.yml so all relative package paths
    # have exactly the same meaning. Remove it even when XcodeGen fails.
    spec={'include':['project.yml'],'targets':{'BetterJITFEXHost':{'settings':{'base':{
        'BETTERJIT_SOURCE_COMMIT':revision,'BETTERJIT_SOURCE_STATE':state
    }}}}}
    with tempfile.NamedTemporaryFile(mode='w',prefix='.fexhost-',suffix='.json',dir=HERE) as file:
        json.dump(spec,file);file.flush()
        subprocess.run(['xcodegen','generate','--spec',file.name],cwd=HERE,check=True)
    print('Project prepared for '+revision+'. Native FEX libraries were not rebuilt.')
    print('Use your existing team/bundle ID, Release, and Debug executable OFF in Xcode.')
if __name__=='__main__': main()
