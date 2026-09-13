"use strict";

const ACG_CHARACTER_TAGS = Object.freeze([
  {
    "name": "傲娇",
    "category": "基础性格"
  },
  {
    "name": "病娇",
    "category": "基础性格"
  },
  {
    "name": "天然呆",
    "category": "基础性格"
  },
  {
    "name": "三无",
    "category": "基础性格"
  },
  {
    "name": "无口",
    "category": "基础性格"
  },
  {
    "name": "腹黑",
    "category": "基础性格"
  },
  {
    "name": "元气",
    "category": "基础性格"
  },
  {
    "name": "温柔",
    "category": "基础性格"
  },
  {
    "name": "高冷",
    "category": "基础性格"
  },
  {
    "name": "冷酷",
    "category": "基础性格"
  },
  {
    "name": "傲慢",
    "category": "基础性格"
  },
  {
    "name": "胆小",
    "category": "基础性格"
  },
  {
    "name": "认真",
    "category": "基础性格"
  },
  {
    "name": "懒散",
    "category": "基础性格"
  },
  {
    "name": "中二病",
    "category": "基础性格"
  },
  {
    "name": "抖S",
    "category": "基础性格"
  },
  {
    "name": "抖M",
    "category": "基础性格"
  },
  {
    "name": "热血",
    "category": "基础性格"
  },
  {
    "name": "乐天派",
    "category": "基础性格"
  },
  {
    "name": "悲观",
    "category": "基础性格"
  },
  {
    "name": "毒舌",
    "category": "基础性格"
  },
  {
    "name": "害羞",
    "category": "基础性格"
  },
  {
    "name": "自恋",
    "category": "基础性格"
  },
  {
    "name": "忠犬",
    "category": "基础性格"
  },
  {
    "name": "女王",
    "category": "基础性格"
  },
  {
    "name": "大小姐",
    "category": "基础性格"
  },
  {
    "name": "傻白甜",
    "category": "基础性格"
  },
  {
    "name": "冷静",
    "category": "基础性格"
  },
  {
    "name": "天然黑",
    "category": "基础性格"
  },
  {
    "name": "双重人格",
    "category": "基础性格"
  },
  {
    "name": "孤僻",
    "category": "基础性格"
  },
  {
    "name": "老好人",
    "category": "基础性格"
  },
  {
    "name": "口嫌体正直",
    "category": "分支性格"
  },
  {
    "name": "弱气",
    "category": "分支性格"
  },
  {
    "name": "强气",
    "category": "分支性格"
  },
  {
    "name": "电波系",
    "category": "分支性格"
  },
  {
    "name": "不良",
    "category": "分支性格"
  },
  {
    "name": "优等生",
    "category": "分支性格"
  },
  {
    "name": "风纪委员",
    "category": "分支性格"
  },
  {
    "name": "吃货",
    "category": "分支性格"
  },
  {
    "name": "路痴",
    "category": "分支性格"
  },
  {
    "name": "音痴",
    "category": "分支性格"
  },
  {
    "name": "机械白痴",
    "category": "分支性格"
  },
  {
    "name": "守财奴",
    "category": "分支性格"
  },
  {
    "name": "赌徒",
    "category": "分支性格"
  },
  {
    "name": "工作狂",
    "category": "分支性格"
  },
  {
    "name": "家里蹲",
    "category": "分支性格"
  },
  {
    "name": "社恐",
    "category": "分支性格"
  },
  {
    "name": "社牛",
    "category": "分支性格"
  },
  {
    "name": "现充",
    "category": "分支性格"
  },
  {
    "name": "御宅族",
    "category": "分支性格"
  },
  {
    "name": "技术宅",
    "category": "分支性格"
  },
  {
    "name": "军事宅",
    "category": "分支性格"
  },
  {
    "name": "历史宅",
    "category": "分支性格"
  },
  {
    "name": "妹控",
    "category": "分支性格"
  },
  {
    "name": "兄控",
    "category": "分支性格"
  },
  {
    "name": "姐控",
    "category": "分支性格"
  },
  {
    "name": "弟控",
    "category": "分支性格"
  },
  {
    "name": "萝莉控",
    "category": "分支性格"
  },
  {
    "name": "正太控",
    "category": "分支性格"
  },
  {
    "name": "洁癖",
    "category": "分支性格"
  },
  {
    "name": "收集癖",
    "category": "分支性格"
  },
  {
    "name": "记仇",
    "category": "分支性格"
  },
  {
    "name": "健忘",
    "category": "分支性格"
  },
  {
    "name": "怕麻烦",
    "category": "分支性格"
  },
  {
    "name": "花痴",
    "category": "分支性格"
  },
  {
    "name": "闷骚",
    "category": "分支性格"
  },
  {
    "name": "面瘫",
    "category": "分支性格"
  },
  {
    "name": "笑面虎",
    "category": "分支性格"
  },
  {
    "name": "跟踪狂",
    "category": "分支性格"
  },
  {
    "name": "独占欲",
    "category": "分支性格"
  },
  {
    "name": "妄想癖",
    "category": "分支性格"
  },
  {
    "name": "演技派",
    "category": "分支性格"
  },
  {
    "name": "嗜睡",
    "category": "分支性格"
  },
  {
    "name": "夜行性",
    "category": "分支性格"
  },
  {
    "name": "酒豪",
    "category": "分支性格"
  },
  {
    "name": "酒品极差",
    "category": "分支性格"
  },
  {
    "name": "怕鬼",
    "category": "分支性格"
  },
  {
    "name": "不幸体质",
    "category": "分支性格"
  },
  {
    "name": "幸运体质",
    "category": "分支性格"
  },
  {
    "name": "冒失娘",
    "category": "分支性格"
  },
  {
    "name": "迟到惯犯",
    "category": "分支性格"
  },
  {
    "name": "大和抚子",
    "category": "分支性格"
  },
  {
    "name": "姐御",
    "category": "分支性格"
  },
  {
    "name": "骑士道",
    "category": "分支性格"
  },
  {
    "name": "完美主义",
    "category": "分支性格"
  },
  {
    "name": "选择困难",
    "category": "分支性格"
  },
  {
    "name": "自来熟",
    "category": "分支性格"
  },
  {
    "name": "慢热",
    "category": "分支性格"
  },
  {
    "name": "逞强",
    "category": "分支性格"
  },
  {
    "name": "爱哭鬼",
    "category": "分支性格"
  },
  {
    "name": "撒娇鬼",
    "category": "分支性格"
  },
  {
    "name": "恋爱脑",
    "category": "分支性格"
  },
  {
    "name": "恋爱绝缘体",
    "category": "分支性格"
  },
  {
    "name": "三分钟热度",
    "category": "分支性格"
  },
  {
    "name": "好奇心旺盛",
    "category": "分支性格"
  },
  {
    "name": "恶作剧爱好者",
    "category": "分支性格"
  },
  {
    "name": "绿茶",
    "category": "分支性格"
  },
  {
    "name": "双马尾",
    "category": "外观-发型"
  },
  {
    "name": "单马尾",
    "category": "外观-发型"
  },
  {
    "name": "侧马尾",
    "category": "外观-发型"
  },
  {
    "name": "姬发式",
    "category": "外观-发型"
  },
  {
    "name": "呆毛",
    "category": "外观-发型"
  },
  {
    "name": "短发",
    "category": "外观-发型"
  },
  {
    "name": "波波头",
    "category": "外观-发型"
  },
  {
    "name": "长直发",
    "category": "外观-发型"
  },
  {
    "name": "及腰长发",
    "category": "外观-发型"
  },
  {
    "name": "及地长发",
    "category": "外观-发型"
  },
  {
    "name": "大波浪",
    "category": "外观-发型"
  },
  {
    "name": "螺旋卷",
    "category": "外观-发型"
  },
  {
    "name": "麻花辫",
    "category": "外观-发型"
  },
  {
    "name": "双麻花辫",
    "category": "外观-发型"
  },
  {
    "name": "丸子头",
    "category": "外观-发型"
  },
  {
    "name": "双丸子头",
    "category": "外观-发型"
  },
  {
    "name": "公主头",
    "category": "外观-发型"
  },
  {
    "name": "狼尾",
    "category": "外观-发型"
  },
  {
    "name": "刺猬头",
    "category": "外观-发型"
  },
  {
    "name": "大背头",
    "category": "外观-发型"
  },
  {
    "name": "遮眼发",
    "category": "外观-发型"
  },
  {
    "name": "凌乱翘发",
    "category": "外观-发型"
  },
  {
    "name": "爆炸头",
    "category": "外观-发型"
  },
  {
    "name": "蘑菇头",
    "category": "外观-发型"
  },
  {
    "name": "齐刘海",
    "category": "外观-刘海"
  },
  {
    "name": "空气刘海",
    "category": "外观-刘海"
  },
  {
    "name": "M字刘海",
    "category": "外观-刘海"
  },
  {
    "name": "斜刘海",
    "category": "外观-刘海"
  },
  {
    "name": "中分",
    "category": "外观-刘海"
  },
  {
    "name": "无刘海",
    "category": "外观-刘海"
  },
  {
    "name": "眉上刘海",
    "category": "外观-刘海"
  },
  {
    "name": "发夹别起",
    "category": "外观-刘海"
  },
  {
    "name": "黑发",
    "category": "外观-发色"
  },
  {
    "name": "白发",
    "category": "外观-发色"
  },
  {
    "name": "银发",
    "category": "外观-发色"
  },
  {
    "name": "金发",
    "category": "外观-发色"
  },
  {
    "name": "红发",
    "category": "外观-发色"
  },
  {
    "name": "粉发",
    "category": "外观-发色"
  },
  {
    "name": "蓝发",
    "category": "外观-发色"
  },
  {
    "name": "绿发",
    "category": "外观-发色"
  },
  {
    "name": "紫发",
    "category": "外观-发色"
  },
  {
    "name": "棕发",
    "category": "外观-发色"
  },
  {
    "name": "橙发",
    "category": "外观-发色"
  },
  {
    "name": "灰发",
    "category": "外观-发色"
  },
  {
    "name": "渐变发",
    "category": "外观-发色"
  },
  {
    "name": "挑染",
    "category": "外观-发色"
  },
  {
    "name": "阴阳双色",
    "category": "外观-发色"
  },
  {
    "name": "虹彩发",
    "category": "外观-发色"
  },
  {
    "name": "异色瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "红瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "金瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "蓝瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "紫瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "翠瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "黑瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "死鱼眼",
    "category": "外观-眼睛"
  },
  {
    "name": "三白眼",
    "category": "外观-眼睛"
  },
  {
    "name": "吊梢眼",
    "category": "外观-眼睛"
  },
  {
    "name": "下垂眼",
    "category": "外观-眼睛"
  },
  {
    "name": "狐狸眼",
    "category": "外观-眼睛"
  },
  {
    "name": "竖瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "无高光瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "心形瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "星光瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "白瞳",
    "category": "外观-眼睛"
  },
  {
    "name": "长睫毛",
    "category": "外观-眼睛"
  },
  {
    "name": "普通人耳",
    "category": "外观-耳朵"
  },
  {
    "name": "精灵尖耳",
    "category": "外观-耳朵"
  },
  {
    "name": "猫耳",
    "category": "外观-耳朵"
  },
  {
    "name": "犬耳",
    "category": "外观-耳朵"
  },
  {
    "name": "狐耳",
    "category": "外观-耳朵"
  },
  {
    "name": "兔耳",
    "category": "外观-耳朵"
  },
  {
    "name": "垂耳",
    "category": "外观-耳朵"
  },
  {
    "name": "鱼鳍耳",
    "category": "外观-耳朵"
  },
  {
    "name": "机械耳",
    "category": "外观-耳朵"
  },
  {
    "name": "童颜",
    "category": "外观-面部"
  },
  {
    "name": "瓜子脸",
    "category": "外观-面部"
  },
  {
    "name": "圆脸",
    "category": "外观-面部"
  },
  {
    "name": "英气剑眉",
    "category": "外观-面部"
  },
  {
    "name": "柳叶眉",
    "category": "外观-面部"
  },
  {
    "name": "雀斑",
    "category": "外观-面部"
  },
  {
    "name": "泪痣",
    "category": "外观-面部"
  },
  {
    "name": "唇下痣",
    "category": "外观-面部"
  },
  {
    "name": "酒窝",
    "category": "外观-面部"
  },
  {
    "name": "高挺鼻梁",
    "category": "外观-面部"
  },
  {
    "name": "脸红体质",
    "category": "外观-面部"
  },
  {
    "name": "胡渣",
    "category": "外观-面部"
  },
  {
    "name": "婴儿肥",
    "category": "外观-面部"
  },
  {
    "name": "樱桃小嘴",
    "category": "外观-嘴牙"
  },
  {
    "name": "厚唇",
    "category": "外观-嘴牙"
  },
  {
    "name": "薄唇",
    "category": "外观-嘴牙"
  },
  {
    "name": "虎牙",
    "category": "外观-嘴牙"
  },
  {
    "name": "吸血鬼獠牙",
    "category": "外观-嘴牙"
  },
  {
    "name": "鲨鱼齿",
    "category": "外观-嘴牙"
  },
  {
    "name": "猫嘴",
    "category": "外观-嘴牙"
  },
  {
    "name": "兔门牙",
    "category": "外观-嘴牙"
  },
  {
    "name": "长舌",
    "category": "外观-嘴牙"
  },
  {
    "name": "白皙肌",
    "category": "外观-肤质"
  },
  {
    "name": "苍白病弱肌",
    "category": "外观-肤质"
  },
  {
    "name": "小麦肌",
    "category": "外观-肤质"
  },
  {
    "name": "棕褐肌",
    "category": "外观-肤质"
  },
  {
    "name": "黑皮辣妹肌",
    "category": "外观-肤质"
  },
  {
    "name": "晒痕",
    "category": "外观-肤质"
  },
  {
    "name": "鳞片肌",
    "category": "外观-肤质"
  },
  {
    "name": "发光肌",
    "category": "外观-肤质"
  },
  {
    "name": "娇小玲珑",
    "category": "外观-身材比例"
  },
  {
    "name": "合法萝莉",
    "category": "外观-身材比例"
  },
  {
    "name": "高挑",
    "category": "外观-身材比例"
  },
  {
    "name": "长身",
    "category": "外观-身材比例"
  },
  {
    "name": "魁梧壮硕",
    "category": "外观-身材比例"
  },
  {
    "name": "纤细骨感",
    "category": "外观-身材比例"
  },
  {
    "name": "丰腴",
    "category": "外观-身材比例"
  },
  {
    "name": "微胖软糯",
    "category": "外观-身材比例"
  },
  {
    "name": "肌肉紧实",
    "category": "外观-身材比例"
  },
  {
    "name": "九头身",
    "category": "外观-身材比例"
  },
  {
    "name": "沙漏型",
    "category": "外观-身材比例"
  },
  {
    "name": "标准匀称",
    "category": "外观-身材比例"
  },
  {
    "name": "绝壁",
    "category": "外观-胸部"
  },
  {
    "name": "微乳",
    "category": "外观-胸部"
  },
  {
    "name": "普通胸围",
    "category": "外观-胸部"
  },
  {
    "name": "美乳",
    "category": "外观-胸部"
  },
  {
    "name": "巨乳",
    "category": "外观-胸部"
  },
  {
    "name": "爆乳",
    "category": "外观-胸部"
  },
  {
    "name": "厚实胸肌",
    "category": "外观-胸部"
  },
  {
    "name": "小蛮腰",
    "category": "外观-腰腹"
  },
  {
    "name": "水蛇腰",
    "category": "外观-腰腹"
  },
  {
    "name": "马甲线",
    "category": "外观-腰腹"
  },
  {
    "name": "八块腹肌",
    "category": "外观-腰腹"
  },
  {
    "name": "软软小肚腩",
    "category": "外观-腰腹"
  },
  {
    "name": "腰窝",
    "category": "外观-腰腹"
  },
  {
    "name": "宽厚腰背",
    "category": "外观-腰腹"
  },
  {
    "name": "翘臀",
    "category": "外观-臀腿"
  },
  {
    "name": "丰臀",
    "category": "外观-臀腿"
  },
  {
    "name": "小巧翘臀",
    "category": "外观-臀腿"
  },
  {
    "name": "大长腿",
    "category": "外观-臀腿"
  },
  {
    "name": "筷子腿",
    "category": "外观-臀腿"
  },
  {
    "name": "肉感大腿",
    "category": "外观-臀腿"
  },
  {
    "name": "肌肉腿",
    "category": "外观-臀腿"
  },
  {
    "name": "绝对领域",
    "category": "外观-臀腿"
  },
  {
    "name": "纤纤玉手",
    "category": "外观-手足"
  },
  {
    "name": "骨节分明",
    "category": "外观-手足"
  },
  {
    "name": "老茧之手",
    "category": "外观-手足"
  },
  {
    "name": "钢琴手",
    "category": "外观-手足"
  },
  {
    "name": "利爪",
    "category": "外观-手足"
  },
  {
    "name": "肉垫",
    "category": "外观-手足"
  },
  {
    "name": "小巧玉足",
    "category": "外观-手足"
  },
  {
    "name": "赤足",
    "category": "外观-手足"
  },
  {
    "name": "猫尾",
    "category": "外观-特殊部位"
  },
  {
    "name": "狐尾",
    "category": "外观-特殊部位"
  },
  {
    "name": "九尾",
    "category": "外观-特殊部位"
  },
  {
    "name": "犬尾",
    "category": "外观-特殊部位"
  },
  {
    "name": "兔绒尾",
    "category": "外观-特殊部位"
  },
  {
    "name": "龙尾",
    "category": "外观-特殊部位"
  },
  {
    "name": "恶魔尾",
    "category": "外观-特殊部位"
  },
  {
    "name": "天使白翼",
    "category": "外观-特殊部位"
  },
  {
    "name": "恶魔黑翼",
    "category": "外观-特殊部位"
  },
  {
    "name": "蝙蝠翼",
    "category": "外观-特殊部位"
  },
  {
    "name": "龙角",
    "category": "外观-特殊部位"
  },
  {
    "name": "恶魔弯角",
    "category": "外观-特殊部位"
  },
  {
    "name": "独角",
    "category": "外观-特殊部位"
  },
  {
    "name": "光环",
    "category": "外观-特殊部位"
  },
  {
    "name": "人鱼尾",
    "category": "外观-特殊部位"
  },
  {
    "name": "蛇身",
    "category": "外观-特殊部位"
  },
  {
    "name": "机械义肢",
    "category": "外观-特殊部位"
  },
  {
    "name": "刀疤",
    "category": "外观-身体印记"
  },
  {
    "name": "烧伤痕",
    "category": "外观-身体印记"
  },
  {
    "name": "纹身",
    "category": "外观-身体印记"
  },
  {
    "name": "魔法咒印",
    "category": "外观-身体印记"
  },
  {
    "name": "胎记",
    "category": "外观-身体印记"
  },
  {
    "name": "全身绷带",
    "category": "外观-身体印记"
  },
  {
    "name": "缝合线",
    "category": "外观-身体印记"
  },
  {
    "name": "兽斑",
    "category": "外观-身体印记"
  },
  {
    "name": "条形码",
    "category": "外观-身体印记"
  },
  {
    "name": "义眼",
    "category": "外观-身体印记"
  },
  {
    "name": "眼镜",
    "category": "外观-服饰配件"
  },
  {
    "name": "眼罩",
    "category": "外观-服饰配件"
  },
  {
    "name": "蝴蝶结发饰",
    "category": "外观-服饰配件"
  },
  {
    "name": "项圈",
    "category": "外观-服饰配件"
  },
  {
    "name": "女仆装",
    "category": "外观-服饰配件"
  },
  {
    "name": "JK制服",
    "category": "外观-服饰配件"
  },
  {
    "name": "哥特萝莉",
    "category": "外观-服饰配件"
  },
  {
    "name": "甜系洛丽塔",
    "category": "外观-服饰配件"
  },
  {
    "name": "旗袍",
    "category": "外观-服饰配件"
  },
  {
    "name": "和服",
    "category": "外观-服饰配件"
  },
  {
    "name": "巫女服",
    "category": "外观-服饰配件"
  },
  {
    "name": "修女服",
    "category": "外观-服饰配件"
  },
  {
    "name": "军装",
    "category": "外观-服饰配件"
  },
  {
    "name": "白大褂",
    "category": "外观-服饰配件"
  },
  {
    "name": "兔女郎装",
    "category": "外观-服饰配件"
  },
  {
    "name": "死库水",
    "category": "外观-服饰配件"
  },
  {
    "name": "过膝袜",
    "category": "外观-服饰配件"
  },
  {
    "name": "吊带袜",
    "category": "外观-服饰配件"
  },
  {
    "name": "长手套",
    "category": "外观-服饰配件"
  },
  {
    "name": "兜帽斗篷",
    "category": "外观-服饰配件"
  }
].map(Object.freeze));

