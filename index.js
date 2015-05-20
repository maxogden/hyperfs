var path = require('path')
var level = require('level')
var crypto = require('crypto')
var mkdirp = require('mkdirp')
var pumpify = require('pumpify')
var pump = require('pump')
var fs = require('fs')
var fuse = require('fuse-bindings')
var lexint = require('lexicographic-integer')
var union = require('sorted-union-stream')
var events = require('events')
var mknod = require('mknod')
var subleveldown = require('subleveldown')
var enumerate = require('level-enumerate')

var noop = function () {}
var ENOENT = new Error('ENOENT')
ENOENT.code = 'ENOENT'

module.exports = function (home) {
  var cauf = {}
  var db = level(path.join(home, 'db'))

  var getId = enumerate(subleveldown(db, 'ids'))
  var metadata = subleveldown(db, 'metadata', {valueEncoding: 'json'})
  var inodes = subleveldown(db, 'inodes', {valueEncoding: 'json'})

  var writeablePath = function () {
    var name = crypto.randomBytes(32).toString('hex')
    return path.join(home, 'writeable', name.slice(0, 2), name.slice(2, 4), name.slice(4))
  }

  var toIndexKey = function(name) {
    var depth = name.split('/').length - 1
    return lexint.pack(depth, 'hex') + '!' + name
  }

  cauf.put = function (id, name, data, cb) {
    var key = id + '!' + toIndexKey(name)
    if (!data.ctime) data.ctime = Date.now()
    if (!data.mtime) data.mtime = Date.now()
    metadata.put(key, data, cb)
  }

  cauf.del = function (id, name, cb) {
    var key = id + '!' + toIndexKey(name)
    metadata.del(key, cb)
  }

  cauf.get = function (id, name, cb) {
    var key = id + '!' + toIndexKey(name)
    metadata.get(key, cb)
  }

  cauf.unmount = function (mnt, cb) {
    fuse.unmount(mnt, cb)
  }

  var dirStream = function (layer, key) {
    return metadata.createReadStream({
      gt: layer + '!' + key,
      lt: layer + '!' + key + '\xff'
    })
  }

  var getInode = function (layer, ino, cb) {
    inodes.get(layer + '!' + lexint.pack(ino, 'hex'), cb)
  }

  var putInode = function (layer, ino, data, cb) {
    inodes.put(layer + '!' + lexint.pack(ino, 'hex'), data, cb)
  }

  var delInode = function (layer, ino, cb) {
    inodes.del(layer + '!' + lexint.pack(ino, 'hex'), cb)
  }

  var countInodes = function (layer, cb) {
    var rs = inodes.createKeyStream({
      gt: layer + '!',
      lt: layer + '!\xff',
      limit: 1,
      reverse: true
    })

    var cnt = 0

    rs.on('data', function (data) {
      cnt = lexint.unpack(data.split('!')[1], 'hex')
    })

    rs.on('error', function (err) {
      cb(err)
    })

    rs.on('end', function () {
      cb(null, cnt)
    })
  }

  var toCompareKey = function (data) {
    return data.key.slice(data.key.indexOf('!') + 1)
  }

  cauf.mount = function (mnt, opts) {
    if (!opts) opts = {}

    var mount = new events.EventEmitter()

    mount.id = null
    mount.layers = null
    mount.mountpoint = mnt
    mount.inodes = 0
    mount.unmount = cauf.unmount.bind(cauf, mnt)

    var wrap = function (cb) {
      return function (err) {
        if (err) return cb(fuse.errno(err.code))
        cb(0)
      }
    }

    var get = function (name, cb) {
      var loop = function (i) {
        if (i < 0) return cb(ENOENT)
        cauf.get(mount.layers[i], name, function (err, file) {
          if (err) return loop(i - 1)
          if (file.deleted) return cb(ENOENT)
          cb(null, file, mount.layers[i])
        })
      }

      loop(mount.layers.length - 1)
    }

    var del = function (name, ino, cb) {
      var oninode = function (err) {
        if (err) return cb(err)
        getInode(mount.id, ino, function (err, data) {
          if (err) return cb(err)
          data.refs.splice(data.refs.indexOf(name), 1)
          if (data.refs.length) return putInode(mount.id, ino, data, cb)
          delInode(mount.id, ino, function (err) {
            if (err) return cb(err)
            if (!data.data) return cb()
            fs.unlink(data.data, cb)
          })
        })
      }

      var loop = function (i) {
        if (i === mount.layers.length - 1) return cauf.del(mount.id, name, oninode)
        cauf.get(mount.layers[i], name, function (err, file) {
          if (err) return loop(i + 1)
          cauf.put(mount.id, name, {deleted: true}, oninode)
        })
      }

      loop(0)
    }

    var cow = function (name, cb) { // TODO: batch for me for speed/consistency
      get(name, function (err, file, layer) {
        if (err) return cb(err)
        if (layer === mount.id) return cb(null, file)

        var store = function (data) {
          if (data.refs.length === 1) {
            cauf.put(mount.id, name, file, function (err) {
              if (err) return cb(err)
              cb(null, file)
            })
            return
          }

          var i = 0
          var loop = function (err) {
            if (err) return cb(err)
            if (i === data.refs.length) return cb(null, file)
            var r = data.refs[i++]
            get(r, function (err, file) {
              if (err) return cb(err)
              cauf.put(mount.id, r, file, loop)
            })
          }

          loop(0)
        }

        var copy = function (from, to, cb) {
          mkdirp(path.join(to, '..'), function (err) {
            if (err) return cb(err)
            if (file.special) return mknod(to, file.mode, file.rdev, cb)
            pump(fs.createReadStream(from), fs.createWriteStream(to), cb)
          })
        }

        getInode(mount.id, file.ino, function (err) {
          if (!err) return cb(null, file) // already copied
          getInode(layer, file.ino, function (err, data) {
            if (err) return cb(err)
            if (!data.data) return cb(null, file) // no data attached ...

            var newPath = writeablePath()
            copy(data.data, newPath, function (err) {
              if (err) return cb(err)
              putInode(mount.id, file.ino, {refs: data.refs, data: newPath}, function (err) {
                if (err) return cb(err)
                store(data)
              })
            })
          })
        })
      })
    }

    var ready = function (root) {
      var link = function (name, dest, cb) {
        cow(name, function (err, file) {
          if (err) return cb(fuse.errno(err.code))
          cauf.put(mount.id, dest, file, function (err) {
            if (err) return cb(fuse.errno(err.code))
            getInode(mount.id, file.ino, function (err, data) {
              if (err) return cb(fuse.errno(err.code))
              data.refs.push(dest)
              putInode(mount.id, file.ino, data, wrap(cb))
            })
          })
        })
      }

      var getattr = function (name, cb) {
        if (name === '/') return cb(0, root)

        get(name, function (err, file, layer) {
          if (err) return cb(fuse.errno(err.code))

          var nlink = 1
          var onstat = function (err, stat) {
            if (err) return cb(fuse.errno(err.code))
            cb(0, {
              mode: file.mode,
              size: file.size || stat.size,
              blksize: 4096,
              blocks: stat.blocks,
              dev: stat.dev,
              rdev: file.rdev || stat.rdev,
              nlink: nlink,
              ino: file.ino || stat.ino,
              uid: file.uid || process.getuid(),
              gid: file.gid || process.getgid(),
              mtime: new Date(file.mtime || 0),
              ctime: new Date(file.ctime || 0),
              atime: new Date(file.mtime || 0)
            })
          }

          if (file.mode & 040000) return onstat(null, root)

          getInode(layer, file.ino, function (err, inode) {
            if (err) return cb(fuse.errno(err.code))
            nlink = inode.refs.length
            fs.lstat(inode.data, onstat)
          })
        })
      }

      var readdir = function (name, cb) {
        if (!/\/$/.test(name)) name += '/'

        var key = toIndexKey(name)
        var result = []

        var stream = dirStream(mount.layers[mount.layers.length - 1], key)
        for (var i = mount.layers.length - 2; i >= 0; i--) {
          stream = union(stream, dirStream(mount.layers[i], key), toCompareKey)
        }

        stream.on('error', wrap(cb))

        stream.on('data', function (data) {
          if (data.value.deleted) return
          result.push(data.key.slice(data.key.lastIndexOf('/') + 1)) // haxx
        })

        stream.on('end', function () {
          cb(null, result)
        })
      }

      var truncate = function (name, size, cb) {
        cow(name, function (err, file) {
          if (err) return cb(fuse.errno(err.code))
          getInode(mount.id, file.ino, function (err, data) {
            if (err) return cb(fuse.errno(err.code))
            fs.truncate(data.data, size, wrap(cb))
          })
        })
      }

      var rename = function (name, dest, cb) {
        link(name, dest, function (errno) {
          if (errno) return cb(errno)
          unlink(name, cb)
        })
      }

      var mknod = function (name, mode, dev, cb) {
        console.log('mknod', name, mode, dev)
        var inode = ++mount.inodes
        var filename = writeablePath()

        putInode(mount.id, inode, {data: filename, refs: [name]}, function (err) {
          if (err) return cb(fuse.errno(err.code))
          mkdirp(path.join(filename, '..'), function (err) {
            if (err) return cb(fuse.errno(err.code))
            mknod(filename, mode, dev, function (err) {
              if (err) return cb(fuse.errno(err.code))
              cauf.put(name, {special: true, rdev: dev, mode: mode, ino: inode}, wrap(cb))
            })
          })
        })
      }

      var open = function (name, flags, cb) {
        var open = function (layer, ino) {
          getInode(layer, ino, function (err, data) {
            if (err) return cb(fuse.errno(err.code))
            fs.open(data.data, flags, function (err, fd) {
              if (err) return cb(fuse.errno(err.code))
              cb(0, fd)
            })
          })
        }

        var readonly = function () {
          get(name, function (err, file, layer) {
            if (err) return cb(fuse.errno(err.code))
            if (file.special) return writeMaybe() // special file - always cow
            open(layer, file.ino)
          })
        }

        var writeMaybe = function () {
          cow(name, function (err, file) {
            if (err) return cb(fuse.errno(err))
            open(mount.id, file.ino)
          })
        }

        if (flags === 0) readonly() // readonly
        else writeMaybe() // cow
      }

      var create = function (name, mode, cb) {
        var inode = ++mount.inodes
        var filename = writeablePath()

        putInode(mount.id, inode, {data: filename, refs: [name]}, function (err) {
          if (err) return cb(fuse.errno(err.code))
          mkdirp(path.join(filename, '..'), function (err) {
            if (err) return cb(fuse.errno(err.code))
            fs.open(filename, 'w', mode, function (err, fd) {
              if (err) return cb(fuse.errno(err.code))
              cauf.put(mount.id, name, {mode: mode, ino: inode}, function (err) {
                if (err) return cb(fuse.errno(err.code))
                cb(0, fd)
              })
            })
          })
        })
      }

      var unlink = function (name, cb) {
        cow(name, function (err, file) { // TODO: don't copy file if refs === 1 and deleting
          if (err) return cb(fuse.errno(err.code))
          del(name, file.ino, wrap(cb))
        })
      }

      var mkdir = function (name, mode, cb) {
        var inode = ++mount.inodes
        putInode(mount.id, inode, {refs: [name]}, function (err) {
          if (err) return cb(fuse.errno(err.code))
          cauf.put(mount.id, name, {mode: mode | 040000, ino: inode}, wrap(cb))
        })
      }

      var rmdir = function (name, cb) {
        cow(name, function (err, file) {
          if (err) return cb(fuse.errno(err.code))
          del(name, file.ino, wrap(cb))
        })
      }

      var write = function (name, fd, buf, len, offset, cb) {
        fs.write(fd, buf, 0, len, offset, function (err, bytes) {
          if (err) return cb(fuse.errno(err.code))
          cb(bytes)
        })
      }

      var read = function (name, fd, buf, len, offset, cb) {
        fs.read(fd, buf, 0, len, offset, function (err, bytes) {
          if (err) return cb(fuse.errno(err.code))
          cb(bytes)
        })
      }

      var release = function (name, fd, cb) {
        fs.close(fd, wrap(cb))
      }

      var symlink = function (name, dest, cb) {
        create(dest, 41453, function (errno, fd) {
          if (errno) return cb(errno)

          var buf = new Buffer(name)
          var pos = 0
          var loop = function () {
            fs.write(fd, buf, 0, buf.length, pos, function (err, bytes) {
              if (err) return cb(fuse.errno(err.code))
              if (bytes === buf.length) return fs.close(fd, wrap(cb))
              pos += bytes
              buf = buf.slice(bytes)
              loop()
            })
          }

          loop()
        })
      }

      var readlink = function (name, cb) {
        get(name, function (err, file, layer) {
          if (err) return cb(fuse.errno(err.code))
          getInode(layer, file.ino, function (err, data) {
            if (err) return cb(fuse.errno(err.code))
            fs.readFile(data.data, 'utf-8', function (err, res) {
              if (err) return cb(fuse.errno(err.code))
              cb(0, res)
            })
          })
        })
      }

      var chmod = function (name, mode, cb) {
        cow(name, function (err, file) {
          if (err) return cb(fuse.errno(err.code))
          file.mode = mode
          cauf.put(mount.id, name, file, wrap(cb))
        })
      }

      var chown = function (name, uid, gid, cb) {
        cow(name, function (err, file) {
          if (err) return cb(fuse.errno(err.code))
          file.uid = uid
          file.gid = gid
          cauf.put(mount.id, name, file, wrap(cb))
        })
      }

      var utimens = function (name, ctime, mtime, cb) {
        cow(name, function (err, file) {
          if (err) return cb(fuse.errno(err.code))
          file.ctime = ctime.getTime()
          file.mtime = mtime.getTime()
          cauf.put(mount.id, name, file, wrap(cb))
        })
      }

      fuse.mount(mnt, {
        force: true,
        options: ['suid', 'dev'],
        getattr: getattr,
        readdir: readdir,
        truncate: truncate,
        rename: rename,
        mknod: mknod,
        open: open,
        create: create,
        unlink: unlink,
        mkdir: mkdir,
        rmdir: rmdir,
        link: link,
        symlink: symlink,
        readlink: readlink,
        write: write,
        read: read,
        release: release,
        chown: chown,
        chmod: chmod,
        utimens: utimens
      }, function (err) {
        if (err) return mount.emit('error', err)
        mount.emit('ready')
      })
    }

    var onid = function (err, id) {
      if (err) return mount.emit('error', err)

      mount.id = id.toString()
      mount.layers = [].concat(opts.layers || [], mount.id)
      mount.mountpoint = mnt

      var done = function (ino) {
        mount.inodes = ino
        mkdirp(mnt, function (err) {
          if (err) return mount.emit('error', err)
          fs.stat(mnt, function (err, st) {
            if (err) return mount.emit('error', err)
            ready(st)
          })
        })
      }

      var loop = function (i) {
        if (i < 0) return done(1024)
        countInodes(mount.layers[mount.layers.length - i], function (_, cnt) {
          if (cnt) return done(cnt)
          loop(i - 1)
        })
      }

      loop(mount.layers.length - 1)
    }

    if (opts.id) return onid(null, opts.id)
    getId(mnt, onid)

    return mount
  }

  return cauf
}
