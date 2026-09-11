import { readFileSync } from 'node:fs'
import { loadCity } from '../src/simulation/CityLoader'
const raw = JSON.parse(readFileSync('aoba_city.json','utf8'))
try {
  const { city, issues } = loadCity(raw)
  console.log('LOADED OK')
  console.log('name', city.meta.name, '| seed', city.meta.simulationSeed, '| bounds', JSON.stringify(city.meta.bounds))
  console.log('buildings', city.buildings.length, 'nodes', city.roadNetwork.nodes.length, 'edges', city.roadNetwork.edges.length, 'shelters', city.shelters.length, 'zones', city.groundZones.length, 'districts', city.districts.length)
  console.log('occupancy', city.buildings.reduce((s,b)=>s+b.occupancy,0), '| capacity', city.shelters.reduce((s,b)=>s+b.capacity,0))
  const errs = issues.filter(i=>i.severity==='error'), warns = issues.filter(i=>i.severity==='warning')
  console.log('ERRORS', errs.length, 'WARNINGS', warns.length)
  for (const i of [...errs, ...warns].slice(0,40)) console.log(`  [${i.severity}] ${i.path}: ${i.message}`)
  console.log('\nbuilding[0] normalised:', JSON.stringify(city.buildings[0]))
  console.log('\nedge[0]:', JSON.stringify(city.roadNetwork.edges[0]))
  console.log('shelter[0]:', JSON.stringify(city.shelters[0]))
  console.log('zone[0]:', JSON.stringify({...city.groundZones[0], polygon: city.groundZones[0].polygon.length + ' pts'}))
  console.log('scenario:', JSON.stringify(city.disasterScenarios[0]))
  const uses: Record<string,number> = {}; for (const b of city.buildings) uses[b.use]=(uses[b.use]??0)+1
  console.log('uses:', JSON.stringify(uses))
  const ct: Record<string,number> = {}; for (const b of city.buildings) ct[b.constructionType]=(ct[b.constructionType]??0)+1
  console.log('construction:', JSON.stringify(ct))
  const rc: Record<string,number> = {}; for (const e of city.roadNetwork.edges) rc[e.roadClass]=(rc[e.roadClass]??0)+1
  console.log('roadClass:', JSON.stringify(rc))
  console.log('profiles[0]:', JSON.stringify(city.buildings[0].populationProfile))
} catch (e) {
  console.log('THREW:', (e as Error).message)
  const issues = (e as unknown as {issues?: {severity:string;path:string;message:string}[]}).issues ?? []
  for (const i of issues.slice(0,30)) console.log(`  [${i.severity}] ${i.path}: ${i.message}`)
}
