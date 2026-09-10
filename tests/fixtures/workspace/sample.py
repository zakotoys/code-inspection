"""Code Inspection 的 Python 诊断演示。

1. 执行“Code Inspection: 查看当前诊断”。
2. 删除下面 def greet(name: str) -> str 行末的冒号，制造语法错误。
3. 等待 Pylance 发布诊断，观察 Problems 与 Code Inspection 输出。
4. 补回冒号，等待对应问题消失。

本文件初始状态语法正确；不用运行程序即可测试编辑器诊断。
"""


def greet(name: str) -> str:
    p: str = "test"
    p = p + 1
    ptint(p)
    return f"Hello, {name}!"


print(greet("Python"))
