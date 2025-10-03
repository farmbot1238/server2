const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB init
const db = new sqlite3.Database('./school.db');
db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS teachers (
    teacher_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS students (
    student_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    class TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS exams (
    exam_id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    subject TEXT,
    class TEXT,
    month TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(teacher_id) REFERENCES teachers(teacher_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS questions (
    question_id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER,
    question_text TEXT,
    score INTEGER,
    FOREIGN KEY(exam_id) REFERENCES exams(exam_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS choices (
    choice_id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER,
    choice_text TEXT,
    is_correct INTEGER DEFAULT 0,
    FOREIGN KEY(question_id) REFERENCES questions(question_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    answer_id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    exam_id INTEGER,
    question_id INTEGER,
    choice_id INTEGER,
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(exam_id) REFERENCES exams(exam_id),
    FOREIGN KEY(question_id) REFERENCES questions(question_id),
    FOREIGN KEY(choice_id) REFERENCES choices(choice_id)
  )`);
  // sample teacher if none
  db.get("SELECT COUNT(*) as c FROM teachers", (e,row)=>{
    if(row.c==0){
      db.run("INSERT INTO teachers (name,code) VALUES (?,?)",["أحمد","TCH123"]);
    }
  });
});

// API: teacher login by code
app.post('/api/teacher-login',(req,res)=>{
  const {code} = req.body;
  db.get("SELECT teacher_id,name FROM teachers WHERE code = ?", [code], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'كود خاطئ'});
    res.json({teacher_id: row.teacher_id, name: row.name});
  });
});

// API: create exam (with questions + choices)
app.post('/api/create-exam',(req,res)=>{
  const {teacher_id,subject,class:cls,month,questions} = req.body;
  if(!teacher_id || !subject || !cls || !month) return res.status(400).json({error:'نقص حقول'});
  db.run("INSERT INTO exams (teacher_id,subject,class,month) VALUES (?,?,?,?)",
    [teacher_id,subject,cls,month], function(err){
      if(err) return res.status(500).json({error:err.message});
      const exam_id = this.lastID;
      const insertQ = db.prepare("INSERT INTO questions (exam_id,question_text,score) VALUES (?,?,?)");
      const insertC = db.prepare("INSERT INTO choices (question_id,choice_text,is_correct) VALUES (?,?,?)");
      for(const q of questions || []){
        insertQ.run([exam_id,q.text,q.score], function(err2){
          if(err2) console.error(err2);
          const qid = this.lastID;
          for(const c of q.choices || []){
            insertC.run([qid,c.text,c.is_correct?1:0]);
          }
        });
      }
      insertQ.finalize(()=>{ insertC.finalize(()=>{ res.json({exam_id}); });});
    });
});

// API: list exams for teacher
app.get('/api/teacher-exams/:teacher_id',(req,res)=>{
  const tid = req.params.teacher_id;
  db.all("SELECT * FROM exams WHERE teacher_id = ? ORDER BY created_at DESC",[tid],(e,rows)=>{
    if(e) return res.status(500).json({error:e.message});
    res.json(rows);
  });
});

// API: get full exam (questions + choices)
app.get('/api/exam/:exam_id',(req,res)=>{
  const eId = req.params.exam_id;
  db.get("SELECT * FROM exams WHERE exam_id = ?",[eId],(err,exam)=>{
    if(err || !exam) return res.status(404).json({error:'exam not found'});
    db.all("SELECT * FROM questions WHERE exam_id = ?",[eId],(er,qs)=>{
      if(er) return res.status(500).json({error:er.message});
      const qids = qs.map(q=>q.question_id);
      if(qids.length===0) return res.json({exam,questions:[]});
      db.all(`SELECT * FROM choices WHERE question_id IN (${qids.map(()=>'?').join(',')})`, qids, (ec,chs)=>{
        const byQ = {};
        qs.forEach(q=> byQ[q.question_id] = {...q, choices: []});
        chs.forEach(c=> byQ[c.question_id].choices.push(c));
        res.json({exam,questions: Object.values(byQ)});
      });
    });
  });
});

// API: list exams available for student by class,subject,month
app.get('/api/exams',(req,res)=>{
  const {class:cls,subject,month} = req.query;
  db.all("SELECT * FROM exams WHERE class=? AND subject=? AND month=?",
    [cls,subject,month], (err,rows)=>{
      if(err) return res.status(500).json({error:err.message});
      res.json(rows);
    });
});

// API: submit answers
app.post('/api/submit',(req,res)=>{
  const {student_name,student_class,exam_id,answers} = req.body;
  if(!student_name || !student_class || !exam_id) return res.status(400).json({error:'نقص'});
  // ensure student exists or create
  db.get("SELECT student_id FROM students WHERE name=? AND class=?", [student_name,student_class], (e,row)=>{
    if(e) return res.status(500).json({error:e.message});
    const saveAnswers = (student_id)=>{
      const ins = db.prepare("INSERT INTO answers (student_id,exam_id,question_id,choice_id) VALUES (?,?,?,?)");
      for(const a of answers || []){
        ins.run([student_id,exam_id,a.question_id,a.choice_id]);
      }
      ins.finalize(()=> res.json({ok:true}));
    };
    if(row){
      saveAnswers(row.student_id);
    } else {
      db.run("INSERT INTO students (name,class) VALUES (?,?)",[student_name,student_class], function(err2){
        if(err2) return res.status(500).json({error:err2.message});
        saveAnswers(this.lastID);
      });
    }
  });
});

const PORT = 3000;
app.listen(PORT, ()=> console.log('Server running on',PORT));
