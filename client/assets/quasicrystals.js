const html = document.querySelector('html')
const canvas = document.querySelector('canvas')
const ctx = canvas.getContext('2d')

resizeCanvas()

let cursorX = window.innerWidth / 2
let cursorY = window.innerHeight / 2

const tealbg = "#027D9C"
const orangbg = "#e07a5f"
const pixel = 10

let fill = [69, 142, 157]
let angles = 7
let offset = 0

function randi() {
    return Math.floor(Math.random() * 999)
}

function changebg(color) {
    html.style.backgroundColor = color
    canvas.style.backgroundColor = color
}

function pixellate(x) {
    return pixel * Math.round(x / pixel)
}

function getOpacity(x, y, angle, bonus) {
    let angledX = Math.cos(angle) * x
    let angledY = Math.sin(angle) * y
    return Math.cos(angledX + angledY + offset + bonus*100) * 10
}

function getColor(x, y) {
    let opacity = 0
    let angle = 2 * Math.PI
    let delta = angle / angles
    for (let i = 0; i < angles; i++) {
        opacity += getOpacity(x, y, angle, (Math.PI/angles)*i)
        angle -= delta
    }

    return `rgba(${fill[0]}, ${fill[1]}, ${fill[2]}, ${opacity / angles})`
}

function animate() {
    offset += 1/16
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    for (let x = -canvas.width/2; x < canvas.width/2; x += pixel) {
        for (let y = -canvas.height/2; y < canvas.height/2; y += pixel) {
            ctx.fillStyle = getColor(x/pixel, y/pixel)
            ctx.fillRect(pixellate(x + canvas.width/2), pixellate(y + canvas.height/2), pixel, pixel)
        }
    }

    requestAnimationFrame(animate)
}
animate()

window.addEventListener('resize', resizeCanvas)
function resizeCanvas() {
    canvas.width = window.innerWidth
    canvas.height = Math.max(html.clientHeight, html.scrollHeight, html.offsetHeight)
}

const urls = document.querySelectorAll("a")

let whichbg = 0
for (url of urls) {
    url.addEventListener("mouseenter", (_) => {
        changebg(orangbg)
        fill = [242, 152, 119]
        angles = 2 + 4 * Math.random()
        whichbg += 1
    })
    url.addEventListener("mouseleave", (_) => {
        changebg(tealbg)
        fill = [69, 142, 157]
        angles = 7
    })
}