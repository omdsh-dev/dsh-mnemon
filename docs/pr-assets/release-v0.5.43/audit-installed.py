import argparse,base64,datetime,hashlib,json,pathlib,tarfile
p=argparse.ArgumentParser()
p.add_argument('--state',required=True)
p.add_argument('--artifacts')
p.add_argument('--output',required=True)
p.add_argument('--baseline')
p.add_argument('--previous',action='store_true')
a=p.parse_args()
sha=lambda b:hashlib.sha256(b).hexdigest()
state=pathlib.Path(a.state);profile=state/'dsh-home/profiles/web/node_modules'
installed_root=json.loads((profile/'dsh-mnemon/package.json').read_text())
candidates=[]
if a.artifacts and not a.previous:
 for path in sorted(pathlib.Path(a.artifacts).glob('*.tgz')):
  data=path.read_bytes()
  with tarfile.open(path) as tf:
   manifest=json.load(tf.extractfile('package/package.json'))
   members=[m for m in tf.getmembers() if m.isfile()]
   content={m.name.removeprefix('package/'):(tf.extractfile(m).read(),m.mode & 0o111) for m in members}
  candidates.append((manifest,path.name,data,content))
root=next((m for m,_,_,_ in candidates if m['name']=='dsh-mnemon'),installed_root)
expected={root['name']:root['version'],**{k:v for k,v in root['dependencies'].items() if k.startswith('dsh-mnemon-')}}
versions=[]
for name,version in sorted(expected.items()):
 ip=profile/name
 if not ip.exists():
  found=list((profile/'.pnpm').glob(name+'@*/node_modules/'+name))
  exact=[x for x in found if json.loads((x/'package.json').read_text())['version']==version]
  assert len(exact)==1,(name,version,[str(x) for x in found])
  ip=exact[0]
 actual=json.loads((ip/'package.json').read_text())['version']
 versions.append({'name':name,'expected':version,'actual':actual,'match':version==actual,'source':'frozen candidate' if any(m['name']==name for m,_,_,_ in candidates) else 'immutable npm version'})
package_results=[]
for manifest,filename,data,content in candidates:
 ip=profile/manifest['name']
 if not ip.exists():
  found=list((profile/'.pnpm').glob(manifest['name']+'@*/node_modules/'+manifest['name']))
  ip=next(x for x in found if json.loads((x/'package.json').read_text())['version']==manifest['version'])
 actual_files={str(x.relative_to(ip)) for x in ip.rglob('*') if x.is_file() and 'node_modules' not in x.relative_to(ip).parts}
 details=[]
 for rel,(expected_data,mode) in content.items():
  actual_file=ip/rel
  actual_data=actual_file.read_bytes() if actual_file.exists() else None
  actual_mode=actual_file.stat().st_mode & 0o111 if actual_file.exists() else None
  details.append({'file':rel,'expectedSha256':sha(expected_data),'installedSha256':sha(actual_data) if actual_data is not None else None,'match':actual_data==expected_data,'expectedExecutableBits':oct(mode),'actualExecutableBits':oct(actual_mode) if actual_mode is not None else None,'executableBitsMatch':actual_mode==mode})
 package_results.append({'name':manifest['name'],'version':manifest['version'],'filename':filename,'sha256':sha(data),'integrity':'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode(),'fileCount':len(content),'fileSetMatches':actual_files==set(content),'extraFiles':sorted(actual_files-set(content)),'missingFiles':sorted(set(content)-actual_files),'allFilesMatch':all(x['match'] for x in details),'executableBitsMatch':all(x['executableBitsMatch'] for x in details),'files':details})
hashes={}
for name in ['memories.json','MEMORY.md','USER.md']:
 path=state/'data/runtime'/name
 if path.exists():
  data=path.read_bytes();hashes[name]={'sha256':sha(data),'bytes':len(data)}
result={'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rootVersion':installed_root['version'],'versions':versions,'pinnedPackageCount':len(versions),'versionMismatches':sum(not x['match'] for x in versions),'candidatePackages':package_results,'candidateFileCount':sum(x['fileCount'] for x in package_results),'contentMismatches':sum(not x['match'] for p in package_results for x in p['files']),'executableBitMismatches':sum(not x['executableBitsMatch'] for p in package_results for x in p['files']),'fileSetMismatches':sum(not x['fileSetMatches'] for x in package_results),'hashes':hashes}
if a.baseline:
 baseline=json.loads(pathlib.Path(a.baseline).read_text());result['retentionMatchesBaseline']=hashes==baseline['hashes']
pathlib.Path(a.output).write_text(json.dumps(result,indent=2)+'\n')
summary={k:v for k,v in result.items() if k not in ['versions','candidatePackages']}
print(json.dumps(summary,indent=2))
assert result['pinnedPackageCount']==19
assert result['versionMismatches']==0
assert result['contentMismatches']==0
assert result['executableBitMismatches']==0
assert result['fileSetMismatches']==0
if a.baseline:assert result['retentionMatchesBaseline']
