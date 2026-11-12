import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The third CI runner lives in a guest on a host that also carries cluster guests
 * (infra/ci-runner/README.md, "The runner on jupiter"). What keeps a job's code away from them is a
 * handful of small files that have to agree with each other: a guard that names a bridge, a network
 * that makes it, a script that opens the guest's way out and starts it, and a second guard inside
 * the guest. No build and no test run reads any of them, so a rename in one would pass every check
 * and close nothing: the guard matches the bridge by NAME, and a rule about a bridge that nobody
 * uses is simply never hit.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
const DIR = join(ROOT, 'infra/ci-runner')
const VM = join(DIR, 'vm')
const text = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const vm = (name: string) => text(join(VM, name))
/** Without comment lines: a rule quoted in a comment is not a rule. */
const code = (s: string) => s.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')

const net = vm('ci-net.xml')
const guard = code(vm('lgr-ci-guard.nft'))
const guardUnit = vm('lgr-ci-guard.service')
const up = code(vm('lgr-ci-runner-up'))
const upUnit = vm('lgr-ci-runner.service')
const userData = vm('user-data.tmpl')
const networkConfig = vm('network-config')
const register = code(vm('register.sh'))
const readme = text(join(DIR, 'README.md'))

/** Every private range: the cluster's nodes, the mesh between the hosts, overlays, link-local. */
const PRIVATE = ['10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']
const isPrivate = (ip: string) => {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

const bridge = /<bridge name='([^']+)'/.exec(net)?.[1] ?? ''
const gateway = /<ip address='([0-9.]+)' netmask='255\.255\.255\.0'/.exec(net)?.[1] ?? ''
const subnet = gateway.replace(/\.\d+$/, '.0/24')
/**
 * A file the cloud-config writes: the lines under `- path: <path>`, up to the next file or the next
 * top-level key. (A placeholder stands at the start of its line and is neither.)
 */
const fileInSeed = (path: string) => {
  const lines = userData.split('\n')
  const at = lines.indexOf(`  - path: ${path}`)
  if (at < 0) throw new Error(`user-data.tmpl writes no ${path}`)
  const end = lines.findIndex((l, i) => i > at && (/^  - path: /.test(l) || /^[a-z_]+:/.test(l)))
  return lines.slice(at, end < 0 ? lines.length : end).join('\n')
}

describe('one network, one bridge, one subnet, in every file', () => {
  it('the network is a NAT network with a /24 of its own, and offers the guest nothing', () => {
    expect(net).toContain('<name>ci-net</name>')
    expect(net).toContain("<forward mode='nat'>")
    expect(bridge).toBe('virbr-ci')
    expect(subnet).toBe('10.10.130.0/24')
    // The guest carries its address and its resolvers: no DHCP and no DNS to answer from the host.
    expect(net).toContain("<dns enable='no'/>")
    expect(net).not.toContain('<dhcp>')
  })

  it('every rule of the guard names the bridge that network makes', () => {
    const named = [...guard.matchAll(/\b[io]ifname "([^"]+)"/g)].map(m => m[1])
    expect(named.length).toBe(7)
    expect([...new Set(named)]).toEqual([bridge])
  })

  it('the start script works on that network, that bridge and that subnet', () => {
    expect(up).toContain('NET=ci-net\n')
    expect(up).toContain(`BRIDGE=${bridge}\n`)
    expect(up).toContain(`SUBNET=${subnet}\n`)
    expect(up).toContain('iptables -I FORWARD 1 -i "$BRIDGE" -j LGR_CI_FWD')
  })

  it('the guest sits in that subnet, behind the host\'s address on it, and asks public resolvers', () => {
    const address = /addresses:\s*\n\s+- ([0-9.]+)\/24/.exec(networkConfig)?.[1] ?? ''
    expect(address.replace(/\.\d+$/, '.0/24')).toBe(subnet)
    expect(address).not.toBe(gateway)
    expect(networkConfig).toContain(`via: ${gateway}`)
    const resolvers = /nameservers:\s*\n\s+addresses: \[([^\]]+)\]/.exec(networkConfig)?.[1].split(',').map(s => s.trim()) ?? []
    expect(resolvers.length).toBeGreaterThan(0)
    expect(resolvers.filter(isPrivate)).toEqual([])
  })

  it('the definition in the README gives the guest the network card its address is tied to', () => {
    const mac = /macaddress: "([0-9a-f:]+)"/.exec(networkConfig)?.[1]
    expect(mac).toBeTruthy()
    expect(readme).toContain(`--network network=ci-net,model=virtio,mac=${mac}`)
  })
})

describe('what is closed is closed in every layer', () => {
  /** A named set of the guard, as its list of elements. */
  const setOf = (name: string) => new RegExp(`set ${name} \\{[^}]*elements = \\{([^}]*)\\}`).exec(guard)?.[1].split(',').map(s => s.trim()) ?? []

  it('the host\'s guard closes every private range, all IPv6, and the host itself', () => {
    expect(setOf('private_v4').sort()).toEqual([...PRIVATE].sort())
    expect(guard).toContain(`iifname "${bridge}" ip daddr @private_v4 counter jump refuse`)
    expect(guard).toContain(`iifname "${bridge}" meta nfproto ipv6 counter jump refuse`)
    expect(guard).toContain(`oifname "${bridge}" ct state new counter drop`)
    // From the guest to the host: answers to what the host started, and nothing else.
    const input = guard.slice(guard.indexOf('chain input'), guard.indexOf('chain refuse'))
    expect(input.indexOf(`iifname "${bridge}" ct state established,related accept`)).toBeGreaterThan(0)
    expect(input.indexOf(`iifname "${bridge}" counter jump refuse`)).toBeGreaterThan(input.indexOf('established,related accept'))
  })

  it('of the fleet hosts\' own public addresses, only the public web stays open', () => {
    // Filled in on the host. They are not in this repository.
    expect(setOf('fleet_v4')).toEqual(['@@FLEET_V4@@'])
    const web = guard.indexOf(`iifname "${bridge}" ip daddr @fleet_v4 tcp dport { 80, 443 } counter accept`)
    const rest = guard.indexOf(`iifname "${bridge}" ip daddr @fleet_v4 counter jump refuse`)
    expect(web).toBeGreaterThan(0)
    expect(rest).toBeGreaterThan(web)
    // Two chain policies, the answers to the host's own connections, and that one rule.
    expect([...guard.matchAll(/\baccept\b/g)].length).toBe(4)
  })

  it('what is closed is refused at once, never left to time out', () => {
    // A silent drop makes a page that names a closed address wait for it. The pages under test
    // name one (the analytics tag), and every Playwright test waited its whole timeout.
    const refuse = guard.slice(guard.indexOf('chain refuse'))
    expect(refuse.indexOf('meta l4proto tcp reject with tcp reset')).toBeGreaterThan(0)
    expect(refuse.indexOf('reject with icmpx type admin-prohibited')).toBeGreaterThan(refuse.indexOf('reject with tcp reset'))
    // The one silent drop is for a stranger knocking on the guest's network, not for the guest.
    expect([...guard.matchAll(/\bdrop\b/g)].length).toBe(1)
    const script = code(fileInSeed('/usr/local/sbin/lgr-ci-container-guard'))
    expect(script).toContain('iptables -A LGR_CI_REFUSE -p tcp -j REJECT --reject-with tcp-reset')
    expect(script).toContain('iptables -A LGR_CI_REFUSE -j REJECT --reject-with icmp-admin-prohibited')
    expect(/-j DROP\b/.test(script)).toBe(false)
  })

  it('it is asked before the host\'s own tables, and can be loaded again', () => {
    expect(guard).toContain('type filter hook forward priority filter - 20; policy accept;')
    expect(guard).toContain('type filter hook input priority filter - 20; policy accept;')
    const lines = guard.split('\n').map(l => l.trim()).filter(Boolean)
    expect(lines.slice(0, 3)).toEqual(['table inet lgr_ci_guard', 'delete table inet lgr_ci_guard', 'table inet lgr_ci_guard {'])
  })

  it('the way out drops the private ranges a second time before it lets the rest leave', () => {
    const ranges = /for net in ([0-9./ ]+); do/.exec(up)?.[1].trim().split(/\s+/) ?? []
    expect([...ranges].sort()).toEqual([...PRIVATE].sort())
    const drop = up.indexOf('iptables -A LGR_CI_FWD -d "$net" -j DROP')
    const accept = up.indexOf('iptables -A LGR_CI_FWD -s "$SUBNET" -j ACCEPT')
    expect(drop).toBeGreaterThan(0)
    expect(accept).toBeGreaterThan(drop)
    expect([...up.matchAll(/-j ACCEPT/g)].length).toBe(1)
  })

  it('the layer inside the guest closes the same destinations to a container, and the guest itself', () => {
    const listed = (path: string) => fileInSeed(path).split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !/^(- path|permissions|content):?/.test(l))
    expect(listed('/etc/lgr-ci-closed-v4').sort()).toEqual([...PRIVATE].sort())
    expect(listed('/etc/lgr-ci-fleet-v4')).toEqual(['@@FLEET_V4_LINES@@'])
    const script = fileInSeed('/usr/local/sbin/lgr-ci-container-guard')
    expect(script).toContain('iptables -A LGR_CI_GUARD -d "$net" -m conntrack --ctstate NEW -j LGR_CI_REFUSE')
    expect(script).toContain('done < /etc/lgr-ci-closed-v4')
    // A fleet host: its public web, then nothing.
    const web = script.indexOf('iptables -A LGR_CI_GUARD -d "$host" -p tcp -m multiport --dports 80,443 -j RETURN')
    const rest = script.indexOf('iptables -A LGR_CI_GUARD -d "$host" -m conntrack --ctstate NEW -j LGR_CI_REFUSE')
    expect(web).toBeGreaterThan(0)
    expect(rest).toBeGreaterThan(web)
    expect(script).toContain('done < /etc/lgr-ci-fleet-v4')
    expect(script).toContain('iptables -I DOCKER-USER 1 -j LGR_CI_GUARD')
    expect(script).toContain('iptables -A LGR_CI_GUARD_IN -m conntrack --ctstate NEW -j LGR_CI_REFUSE')
    expect(script).toContain('for br in docker0 br-+; do')
    expect(script).toContain('iptables -I INPUT 1 -i "$br" -j LGR_CI_GUARD_IN')
    // It comes up with Docker, every time Docker does.
    const unit = fileInSeed('/etc/systemd/system/lgr-ci-container-guard.service')
    for (const line of ['After=docker.service', 'Requires=docker.service', 'PartOf=docker.service', 'WantedBy=docker.service']) expect(unit).toContain(line)
    expect(userData).toContain('  - systemctl enable --now lgr-ci-container-guard.service')
  })

  it('a container is given public resolvers, so it has no private address to ask', () => {
    const dns = /"dns": \[([^\]]+)\]/.exec(fileInSeed('/etc/docker/daemon.json'))?.[1].split(',').map(s => s.trim().replace(/"/g, '')) ?? []
    expect(dns.length).toBeGreaterThan(0)
    expect(dns.filter(isPrivate)).toEqual([])
  })

  it('no public address of ours is written down here: only private ones, and the public resolvers', () => {
    const resolvers = ['1.1.1.1', '8.8.8.8']
    const strays: string[] = []
    for (const name of [...readdirSync(VM).map(f => join(VM, f)), join(DIR, 'README.md')]) {
      for (const [ip] of text(name).matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) {
        if (isPrivate(ip) || resolvers.includes(ip) || ip.startsWith('255.')) continue
        strays.push(`${name.slice(ROOT.length + 1).replace(/\\/g, '/')}: ${ip}`)
      }
    }
    expect(strays).toEqual([])
  })
})

describe('the guest starts only behind its guard', () => {
  it('the guard is loaded before libvirt can start anything', () => {
    expect(guardUnit).toContain('Before=libvirtd.service')
    expect(guardUnit).toContain('ExecStart=/usr/sbin/nft -f /etc/lgr-ci-guard.nft')
    expect(guardUnit).toContain('WantedBy=multi-user.target')
  })

  it('the unit that starts the guest needs the guard\'s unit, and runs after it and after libvirt', () => {
    expect(upUnit).toContain('Requires=lgr-ci-guard.service')
    const after = /^After=(.*)$/m.exec(upUnit)?.[1].split(/\s+/) ?? []
    expect(after).toContain('lgr-ci-guard.service')
    expect(after).toContain('libvirtd.service')
    expect(upUnit).toContain('ExecStart=/usr/local/sbin/lgr-ci-runner-up')
  })

  it('the script stops before it opens or starts anything when the guard is not loaded', () => {
    expect(up).toContain('set -euo pipefail')
    const check = up.indexOf('if ! /usr/sbin/nft list table inet lgr_ci_guard')
    const refusal = up.indexOf('exit 1', check)
    const firstRule = up.indexOf('iptables ')
    const start = up.indexOf('virsh start "$DOMAIN"')
    expect(check).toBeGreaterThan(0)
    expect(refusal).toBeGreaterThan(check)
    expect(up.indexOf('fi', check)).toBeGreaterThan(refusal)
    expect(firstRule).toBeGreaterThan(refusal)
    expect(start).toBeGreaterThan(firstRule)
  })

  it('once started, the guest is what the kernel takes first when the host runs out of memory', () => {
    expect(up.indexOf('echo 1000 > "/proc/$pid/oom_score_adj"')).toBeGreaterThan(up.indexOf('virsh start "$DOMAIN"'))
  })

  it('nothing in the recipe sets the guest to start by itself, past that script', () => {
    for (const s of [readme, ...readdirSync(VM).map(f => vm(f))]) expect(/virsh autostart|--autostart\b/.test(s)).toBe(false)
  })
})

describe('the runner in the guest is the runner on mars', () => {
  it('the same image, the same caps, and the label the repository variable names', () => {
    const version = /^ARG RUNNER_VERSION=(\S+)$/m.exec(text(join(DIR, 'Dockerfile')))?.[1]
    expect(version).toBeTruthy()
    expect(register).toContain(`gh-runner-lgr:${version}`)
    expect(readme).toContain(`gh-runner-lgr:${version}`)
    for (const cap of ['--restart unless-stopped', '--cpus 8 --memory 8g --pids-limit 8192', '--tmpfs /tmp:rw,exec,nosuid,size=3g']) {
      expect(register).toContain(cap)
      expect(readme).toContain(cap)
    }
    expect(register).toContain('-e RUNNER_LABELS=lgr-linux,lgr-jupiter')
    expect(readme).toContain('-e RUNNER_LABELS=lgr-linux,lgr-mars')
    expect(text(join(ROOT, '.github/workflows/ci.yml'))).toContain('`["self-hosted","lgr-linux"]`')
  })

  it('the registration token arrives on stdin, never on a command line', () => {
    expect(register).toContain('cat > /s/registration-token')
    expect(/--token|\$1\b|\$\{?T\b/.test(register)).toBe(false)
  })
})
